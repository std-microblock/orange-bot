/**
 * PCM helpers and the utterance segmenter.
 *
 * The open-xiaoai client streams the microphone as 16 kHz, 16-bit, mono little-endian PCM in 30 ms packets
 * (`start_recording` with the default `AudioConfig`). {@link Vad} cuts that stream into utterances with an adaptive
 * energy threshold, and {@link wav} wraps one utterance for the ASR API (16-bit PCM WAV is one of its two formats).
 *
 * @module dsh-plugin-orange-voice/audio
 */

export const MIC_RATE = 16000
/** DeepSeek TTS `format: pcm`: raw 16-bit mono PCM at 24 kHz. */
export const TTS_RATE = 24000

/** A RIFF/WAVE container around 16-bit mono PCM. */
export function wav(pcm: Uint8Array, sampleRate = MIC_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  out.set(pcm, 44)
  return out
}

/** Root mean square of 16-bit little-endian samples. */
export function rms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2)
  if (samples === 0) return 0
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2)
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true)
    sum += s * s
  }
  return Math.sqrt(sum / samples)
}

/** Milliseconds of 16-bit mono PCM at a rate. */
export function durationMs(bytes: number, sampleRate = MIC_RATE): number {
  return (bytes / 2 / sampleRate) * 1000
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.byteLength }
  return out
}

export interface VadOptions {
  minRms: number
  ratio: number
  startMs: number
  silenceMs: number
  minSpeechMs: number
  maxUtteranceMs: number
  preRollMs: number
}

export interface Utterance {
  pcm: Uint8Array
  /** Wall-clock start and end of the speech (ms). */
  startedAt: number
  endedAt: number
  durationMs: number
}

/**
 * Energy VAD: a packet is voiced when its RMS is above both `minRms` and `ratio` × the noise floor, which follows
 * the unvoiced packets (fast down, slow up). An utterance starts after `startMs` of voiced audio (with `preRollMs`
 * of what came before) and ends after `silenceMs` of silence or at `maxUtteranceMs`.
 */
export class Vad {
  private floor = 0
  private pre: Uint8Array[] = []
  private preBytes = 0
  private current: Uint8Array[] | undefined
  private currentBytes = 0
  private voicedRun = 0
  private silentRun = 0
  private speechMs = 0
  private startedAt = 0
  private muted = false

  constructor(private readonly options: VadOptions, private readonly onUtterance: (utterance: Utterance) => void, private readonly now: () => number = Date.now) {}

  /** While muted (the speaker is talking), packets only feed the noise floor and an open utterance is dropped. */
  mute(on: boolean): void {
    this.muted = on
    if (on) this.reset()
  }

  get speaking(): boolean { return this.current !== undefined }

  noiseFloor(): number { return this.floor }

  reset(): void {
    this.current = undefined
    this.currentBytes = 0
    this.voicedRun = 0
    this.silentRun = 0
    this.speechMs = 0
  }

  push(packet: Uint8Array): void {
    const ms = durationMs(packet.byteLength)
    const level = rms(packet)
    const voiced = !this.muted && level >= this.options.minRms && level >= this.floor * this.options.ratio
    if (!voiced) this.floor = this.floor === 0 ? level : level < this.floor ? this.floor * 0.7 + level * 0.3 : this.floor * 0.98 + level * 0.02
    if (this.muted) return

    if (this.current === undefined) {
      this.pre.push(packet)
      this.preBytes += packet.byteLength
      const keep = (this.options.preRollMs + this.options.startMs + 60) * MIC_RATE * 2 / 1000
      while (this.preBytes > keep && this.pre.length > 1) this.preBytes -= this.pre.shift()!.byteLength
      this.voicedRun = voiced ? this.voicedRun + ms : 0
      if (this.voicedRun >= this.options.startMs && this.voicedRun > 0) {
        this.current = [...this.pre]
        this.currentBytes = this.preBytes
        this.pre = []
        this.preBytes = 0
        this.speechMs = this.voicedRun
        this.silentRun = 0
        this.startedAt = this.now() - this.voicedRun
      }
      return
    }

    this.current.push(packet)
    this.currentBytes += packet.byteLength
    if (voiced) { this.speechMs += ms; this.silentRun = 0 } else this.silentRun += ms
    const total = durationMs(this.currentBytes)
    if (this.silentRun >= this.options.silenceMs || total >= this.options.maxUtteranceMs) this.finish()
  }

  private finish(): void {
    const parts = this.current ?? []
    const speech = this.speechMs
    // Trim most of the trailing silence, keeping a short tail.
    const tailBytes = Math.max(0, Math.round((this.silentRun - 200) * MIC_RATE * 2 / 1000))
    const pcm = concat(parts)
    const trimmed = tailBytes > 0 && tailBytes < pcm.byteLength ? pcm.subarray(0, pcm.byteLength - (tailBytes - (tailBytes % 2))) : pcm
    const endedAt = this.now()
    const startedAt = this.startedAt
    this.reset()
    if (speech < this.options.minSpeechMs) return
    this.onUtterance({ pcm: trimmed, startedAt, endedAt, durationMs: durationMs(trimmed.byteLength) })
  }
}

/** Split PCM into chunks of `ms` milliseconds (whole samples). */
export function* chunks(pcm: Uint8Array, ms: number, sampleRate: number): Generator<Uint8Array> {
  const size = Math.max(2, Math.round((sampleRate * 2 * ms) / 1000 / 2) * 2)
  for (let at = 0; at < pcm.byteLength; at += size) yield pcm.subarray(at, Math.min(at + size, pcm.byteLength))
}
