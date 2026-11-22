/**
 * The voice channel: microphone stream → VAD → wake decision → DeepSeek ASR → one delivery into the voice session;
 * and `speak`: text → DeepSeek TTS (or the speaker's own voice) → the speaker.
 *
 * Nothing here knows about sessions: {@link VoiceChannelDeps.deliver} is how a transcript leaves, and the plugin
 * entry turns it into a durable `ctx.im.sessions.deliver`.
 *
 * @module dsh-plugin-orange-voice/voice
 */
import { MIC_RATE, Vad, wav, type Utterance } from './audio.ts'
import type { Config } from './config.ts'
import { asr, tts, type DeepSeekOptions } from './deepseek.ts'
import { WakeGate, type Via } from './gate.ts'
import { SpeakerLink, speakable, type SpeakerStatus } from './speaker.ts'

export interface Transcript {
  id: string
  text: string
  via: Via
  at: number
  durationMs: number
}

export interface HeardRecord {
  at: number
  text?: string
  via?: Via
  outcome: 'delivered' | 'dropped' | 'empty' | 'error'
  reason?: string
  durationMs: number
}

export interface VoiceChannelDeps {
  deliver(transcript: Transcript): Promise<void>
  log(level: 'info' | 'warn', message: string): void
  onChange?(): void
  now?: () => number
  /** For tests: the fetch the DeepSeek client uses. */
  fetch?: typeof fetch
}

export interface SpeakResult { ok: boolean; note: string; spoken?: string; engine?: 'deepseek' | 'native' }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class VoiceChannel {
  readonly link: SpeakerLink
  readonly gate: WakeGate
  private readonly vad: Vad
  private readonly heard: HeardRecord[] = []
  private lastSpoken: { text: string; at: number; engine: string } | undefined
  private sequence = 0
  private unmuteTimer: NodeJS.Timeout | undefined
  private connectionTimer: NodeJS.Timeout | undefined

  constructor(readonly config: Config, private readonly deps: VoiceChannelDeps) {
    const now = deps.now ?? Date.now
    this.gate = new WakeGate(config.wake, now)
    this.vad = new Vad(config.vad, (utterance) => { void this.onUtterance(utterance) }, now)
    this.link = new SpeakerLink(config, {
      audio: (pcm) => this.vad.push(pcm),
      keyword: (word) => {
        if (this.gate.keyword(word)) deps.log('info', `wake word「${word}」`)
        this.changed()
      },
      recognizer: (text, final) => {
        if (!final) { this.gate.nativeListening(); return }
        if (this.gate.nativeResult(text)) deps.log('info', `left to XiaoAI: ${text.slice(0, 60)}`)
        this.changed()
      },
      playing: (state) => {
        // XiaoAI talking or playing music must not be transcribed as the owner.
        this.vad.mute(state === 'playing' || this.link.snapshot().speaking)
      },
      state: () => this.changed(),
      log: deps.log,
    })
  }

  private get deepseek(): DeepSeekOptions {
    return { ...this.config.deepseek, ...this.deps.fetch ? { fetch: this.deps.fetch } : {} }
  }

  async start(): Promise<void> {
    await this.link.start()
    this.watchConnection()
  }

  async stop(): Promise<void> {
    clearTimeout(this.unmuteTimer)
    clearInterval(this.connectionTimer)
    await this.link.stop()
  }

  /** Ask a newly connected client for the microphone stream. */
  private watchConnection(): void {
    let lastConnects = 0
    const tick = async () => {
      const status = this.link.snapshot()
      if (status.connected && status.connects !== lastConnects) {
        lastConnects = status.connects
        try {
          await this.link.startRecording()
          this.deps.log('info', 'microphone stream started')
        } catch (error) {
          this.deps.log('warn', `start_recording failed: ${(error as Error).message}`)
          lastConnects = 0
        }
      }
    }
    // The link emits state on every change; polling the snapshot keeps this independent of the hook order.
    this.connectionTimer = setInterval(() => { void tick() }, 500)
  }

  status(): { speaker: SpeakerStatus; gate: ReturnType<WakeGate['state']>; heard: HeardRecord[]; lastSpoken?: { text: string; at: number; engine: string }; noiseFloor: number; listening: boolean } {
    return {
      speaker: this.link.snapshot(),
      gate: this.gate.state(),
      heard: [...this.heard].reverse(),
      ...this.lastSpoken ? { lastSpoken: this.lastSpoken } : {},
      noiseFloor: Math.round(this.vad.noiseFloor()),
      listening: this.vad.speaking,
    }
  }

  private record(entry: HeardRecord): void {
    this.heard.push(entry)
    if (this.heard.length > 50) this.heard.shift()
    this.changed()
  }

  private changed(): void { try { this.deps.onChange?.() } catch { /* observer */ } }

  /** One utterance ended: decide, transcribe, deliver. */
  async onUtterance(utterance: Utterance): Promise<void> {
    const now = this.deps.now ?? Date.now
    // A native wake: give XiaoAI's recognizer a moment to say whether the sentence is its own.
    if (this.gate.awaitingNative()) {
      const deadline = now() + this.config.wake.nativeWaitMs
      while (this.gate.awaitingNative() && now() < deadline) await sleep(100)
    }
    const decision = this.gate.decide(utterance.endedAt)
    if (decision.action === 'drop') {
      if (decision.reason !== 'no wake') this.record({ at: utterance.endedAt, outcome: 'dropped', reason: decision.reason, durationMs: utterance.durationMs })
      return
    }
    let text: string
    try {
      text = (await asr(this.deepseek, wav(utterance.pcm, MIC_RATE))).text.trim()
    } catch (error) {
      this.deps.log('warn', `ASR failed: ${(error as Error).message}`)
      this.record({ at: utterance.endedAt, via: decision.via, outcome: 'error', reason: (error as Error).message.slice(0, 200), durationMs: utterance.durationMs })
      if (!decision.prefixOnly) this.gate.reopen(decision.via)
      return
    }
    const accepted = this.gate.accept(text, decision.prefixOnly)
    if (accepted === undefined) {
      if (decision.prefixOnly) return // room talk not addressed to the bot: neither kept nor logged
      this.gate.reopen(decision.via)
      this.record({ at: utterance.endedAt, via: decision.via, outcome: 'empty', ...text ? { text } : {}, durationMs: utterance.durationMs })
      return
    }
    if (this.config.takeover && decision.via !== 'follow-up') void this.link.interrupt().catch(() => undefined)
    const transcript: Transcript = { id: `${utterance.endedAt.toString(36)}-${(this.sequence++).toString(36)}`, text: accepted.text, via: decision.via, at: utterance.endedAt, durationMs: utterance.durationMs }
    this.deps.log('info', `heard (${decision.via}): ${accepted.text.slice(0, 80)}`)
    try {
      await this.deps.deliver(transcript)
      this.record({ at: transcript.at, text: transcript.text, via: transcript.via, outcome: 'delivered', durationMs: transcript.durationMs })
    } catch (error) {
      this.deps.log('warn', `delivery failed: ${(error as Error).message}`)
      this.record({ at: transcript.at, text: transcript.text, via: transcript.via, outcome: 'error', reason: (error as Error).message.slice(0, 200), durationMs: transcript.durationMs })
    }
  }

  /** Say something through the speaker. */
  async speak(text: string, options: { interrupt?: boolean; signal?: AbortSignal } = {}): Promise<SpeakResult> {
    if (!this.link.connected) return { ok: false, note: 'the speaker is not connected (client not running, or not on this network)' }
    const said = speakable(text, this.config.maxSpeakChars)
    if (!said) return { ok: false, note: 'nothing to read aloud once links and markdown are removed' }
    if (options.interrupt) await this.link.interrupt().catch(() => undefined)
    this.vad.mute(true)
    try {
      let result: SpeakResult | undefined
      if (this.config.tts === 'deepseek') {
        try {
          await this.link.play(tts(this.deepseek, said, options.signal), 24000, options.signal)
          result = { ok: true, note: `read aloud (DeepSeek TTS, ${this.config.deepseek.voice})`, spoken: said, engine: 'deepseek' }
        } catch (error) {
          this.deps.log('warn', `DeepSeek TTS failed: ${(error as Error).message}`)
          if (!this.config.ttsFallback) return { ok: false, note: `TTS failed: ${(error as Error).message}` }
        }
      }
      if (result === undefined) {
        const native = await this.link.nativeSay(said)
        result = native.ok ? { ok: true, note: native.note, spoken: said, engine: 'native' } : { ok: false, note: native.note }
      }
      if (result.ok) {
        this.lastSpoken = { text: said, at: Date.now(), engine: result.engine ?? '' }
        this.gate.spoke()
      }
      return result
    } finally {
      // The room still echoes for a moment after the last sample.
      clearTimeout(this.unmuteTimer)
      this.unmuteTimer = setTimeout(() => this.vad.mute(this.link.snapshot().playing === 'playing'), 400)
      this.changed()
    }
  }
}
