/**
 * The DeepSeek tool APIs this plugin uses: speech to text (`POST /v1/tools/asr`, multipart `file`, 16-bit PCM WAV or
 * Ogg Opus, ≤ 8 MiB / ≤ 120 s) and text to speech (`POST /v1/tools/tts`, JSON `{ text, voice_id, format,
 * filter_markdown }`, audio streamed in the response body; `format: pcm` is raw 16-bit mono at 24 kHz).
 *
 * Base URL and key are configuration: in deployment the VM holds no real key and a relay on the host injects it.
 *
 * @module dsh-plugin-orange-voice/deepseek
 */

export interface DeepSeekOptions {
  baseUrl: string
  apiKey: string
  voice: string
  asrTimeoutMs: number
  ttsTimeoutMs: number
  fetch?: typeof fetch
}

export class DeepSeekError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const ASR_LIMIT = 8 * 1024 * 1024

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

function headers(options: DeepSeekOptions, extra: Record<string, string> = {}): Record<string, string> {
  return { ...options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}, ...extra }
}

async function failure(response: Response, what: string): Promise<DeepSeekError> {
  let detail = ''
  try { detail = (await response.text()).slice(0, 300) } catch { /* body gone */ }
  return new DeepSeekError(response.status, `${what} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
}

/** Transcribe one WAV (or Ogg Opus) file. */
export async function asr(options: DeepSeekOptions, audio: Uint8Array, signal?: AbortSignal): Promise<{ text: string; durationMs?: number; requestId?: string }> {
  if (audio.byteLength > ASR_LIMIT) throw new DeepSeekError(413, `audio is ${audio.byteLength} bytes; the ASR API takes at most 8 MiB`)
  const form = new FormData()
  form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'speech.wav')
  const timeout = AbortSignal.timeout(options.asrTimeoutMs)
  const response = await (options.fetch ?? fetch)(endpoint(options.baseUrl, '/v1/tools/asr'), {
    method: 'POST',
    headers: headers(options),
    body: form,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw await failure(response, 'ASR')
  const body = await response.json() as { text?: unknown; duration_ms?: unknown; request_id?: unknown }
  return {
    text: typeof body.text === 'string' ? body.text : '',
    ...typeof body.duration_ms === 'number' ? { durationMs: body.duration_ms } : {},
    ...typeof body.request_id === 'string' ? { requestId: body.request_id } : {},
  }
}

/**
 * Synthesize text as raw 24 kHz 16-bit mono PCM, yielding the body as it streams in (so playback can start before
 * synthesis ends). A response that ends early is a failure the caller sees as an error after the chunks it got.
 */
export async function* tts(options: DeepSeekOptions, text: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const timeout = AbortSignal.timeout(options.ttsTimeoutMs)
  const response = await (options.fetch ?? fetch)(endpoint(options.baseUrl, '/v1/tools/tts'), {
    method: 'POST',
    headers: headers(options, { 'content-type': 'application/json' }),
    body: JSON.stringify({ text, voice_id: options.voice, format: 'pcm', filter_markdown: true }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw await failure(response, 'TTS')
  if (response.body === null) return
  let odd: number | undefined
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    // Keep sample alignment across chunk boundaries.
    let bytes = chunk
    if (odd !== undefined) { const merged = new Uint8Array(bytes.byteLength + 1); merged[0] = odd; merged.set(bytes, 1); bytes = merged; odd = undefined }
    if (bytes.byteLength % 2 === 1) { odd = bytes[bytes.byteLength - 1]; bytes = bytes.subarray(0, bytes.byteLength - 1) }
    if (bytes.byteLength > 0) yield bytes
  }
}
