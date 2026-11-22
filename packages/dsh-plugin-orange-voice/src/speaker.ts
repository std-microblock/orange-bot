/**
 * The speaker end: a WebSocket server the open-xiaoai client connects to (it dials `ws://<host>:<port>` itself), and
 * the thin protocol it speaks (`packages/client-rust/src/services/connect/` upstream):
 *
 * - text frames are the externally tagged `AppMessage` enum: `{"Request":{id,command,payload}}`,
 *   `{"Response":{id,code,msg,data}}`, `{"Event":{id,event,data}}`;
 * - binary frames are a bare `Stream` JSON object `{id, tag, bytes:[…]}`: `record` (microphone, speaker → us) and
 *   `play` (playback, us → speaker).
 *
 * Commands the stock client registers: `get_version`, `run_shell`, `start_recording`/`stop_recording`,
 * `start_play`/`stop_play`. Events: `instruction` (XiaoAI's own instruction log, including its recognizer),
 * `playing`, `kws` (custom wake words). Nothing here needs a client change.
 *
 * Security: the protocol has no authentication and `run_shell` is root on the speaker. The server only accepts
 * `allowFrom` addresses (and the token, when one is configured), and the only shell text built from outside input is
 * the `tts_play.sh` argument, single-quoted by {@link shellQuote} after {@link speakable} removed what the script
 * cannot take.
 *
 * @module dsh-plugin-orange-voice/speaker
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { chunks, durationMs, TTS_RATE } from './audio.ts'

export interface SpeakerOptions {
  host: string
  port: number
  allowFrom: readonly string[]
  token: string
  playLeadMs: number
  advertise: string
}

export interface SpeakerHooks {
  /** One microphone packet (16 kHz s16le mono). */
  audio?(pcm: Uint8Array): void
  /** A custom wake word. */
  keyword?(word: string): void
  /** XiaoAI's recognizer: a partial (`final: false`) or final result. */
  recognizer?(text: string, final: boolean, id: string): void
  /** XiaoAI's player state. */
  playing?(state: 'playing' | 'paused' | 'idle'): void
  /** Connection changes and errors, for logs and the panel. */
  state?(status: SpeakerStatus): void
  log?(level: 'info' | 'warn', message: string): void
}

export interface SpeakerStatus {
  connected: boolean
  remote?: string
  connectedAt?: number
  connects: number
  device?: string
  clientVersion?: string
  recording: boolean
  playing: 'playing' | 'paused' | 'idle'
  /** We are pushing audio to the speaker right now. */
  speaking: boolean
  lastError?: string
  commands: number
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** The open-xiaoai `AudioConfig` (every field is required by the client's deserializer). */
export function audioConfig(sampleRate: number): Record<string, unknown> {
  const period = Math.round(sampleRate / 100)
  return { pcm: 'noop', channels: 1, bits_per_sample: 16, sample_rate: sampleRate, period_size: period, buffer_size: period * 3 }
}

/** Single-quote a string for `/bin/sh -c` (this shell is root on the speaker). */
export function shellQuote(text: string): string {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

/**
 * Text that can be read aloud: no markdown marks, links, media placeholders, ASCII double quotes or backslashes
 * (`tts_play.sh` pastes its argument into a JSON string), whitespace collapsed, at most `maxChars`.
 */
export function speakable(text: string, maxChars: number): string {
  const flat = String(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[(?:图片|表情|文件|按钮|视频|语音|合并转发|链接)[^\]]*\]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>~|]/g, '')
    .replace(/["\\]/g, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
  if (!flat) return ''
  return flat.length > maxChars ? `${flat.slice(0, Math.max(1, maxChars - 1))}…` : flat
}

const SHELL = {
  playText: (quoted: string) => `PATH=/data/bin:/usr/sbin:/usr/bin:/sbin:/bin /usr/sbin/tts_play.sh ${quoted}`,
  abort: '/etc/init.d/mico_aivs_lab restart >/dev/null 2>&1',
  model: 'echo $(micocfg_model)',
  boot: 'echo $(fw_env -g boot_part)',
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class SpeakerLink {
  private wss: WebSocketServer | undefined
  private socket: WebSocket | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly status: SpeakerStatus = { connected: false, connects: 0, recording: false, playing: 'idle', speaking: false, commands: 0 }
  private playChain: Promise<unknown> = Promise.resolve()
  private seenFinals = new Set<string>()

  constructor(private readonly options: SpeakerOptions, private readonly hooks: SpeakerHooks = {}) {}

  /** Listen; resolves once the port is bound. */
  start(): Promise<void> {
    const wss = new WebSocketServer({ host: this.options.host, port: this.options.port })
    this.wss = wss
    wss.on('connection', (socket, request) => { this.onConnection(socket, request) })
    return new Promise((resolve, reject) => {
      wss.once('listening', () => {
        this.log('info', `speaker channel listening on ws://${this.options.host}:${this.port()}${this.options.token ? ' (token required)' : ' (no token: expose on the LAN only)'}`)
        resolve()
      })
      wss.once('error', (error) => { this.fail(`listen ${this.options.host}:${this.options.port}: ${error.message}`); reject(error) })
    })
  }

  /** The bound port (useful with `port: 0` in tests). */
  port(): number {
    const address = this.wss?.address()
    return typeof address === 'object' && address !== null ? address.port : this.options.port
  }

  async stop(): Promise<void> {
    this.settle(new Error('speaker channel stopped'))
    try { this.socket?.close() } catch { /* already closed */ }
    this.socket = undefined
    const wss = this.wss
    this.wss = undefined
    if (wss !== undefined) await new Promise<void>((resolve) => wss.close(() => resolve()))
    this.status.connected = false
  }

  get connected(): boolean { return this.socket !== undefined && this.socket.readyState === 1 }

  snapshot(): SpeakerStatus { return { ...this.status } }

  // ------------------------------------------------------------------------------------------- connection
  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const remote = String(request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    if (!this.addressAllowed(remote)) {
      this.log('warn', `speaker connection refused (not in allowFrom): ${remote}`)
      socket.close(4403, 'forbidden')
      return
    }
    if (this.options.token && !this.tokenOk(String(request.url ?? ''))) {
      this.log('warn', `speaker connection refused (bad token): ${remote}`)
      socket.close(4401, 'bad token')
      return
    }
    if (this.socket !== undefined && this.socket !== socket) {
      // The client is a singleton on the speaker: a new connection replaces the old one.
      try { this.socket.close(4409, 'replaced') } catch { /* gone */ }
      this.settle(new Error('speaker reconnected'))
    }
    this.socket = socket
    Object.assign(this.status, { connected: true, remote, connectedAt: Date.now(), recording: false, speaking: false })
    this.status.connects += 1
    this.log('info', `speaker connected (${remote})`)
    this.emit()
    socket.on('message', (data, binary) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
        const frame = JSON.parse(text) as Record<string, unknown>
        if (binary) this.onStream(frame)
        else this.onText(frame)
      } catch (error) {
        this.log('warn', `speaker frame not understood: ${(error as Error).message}`)
      }
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      Object.assign(this.status, { connected: false, recording: false, speaking: false })
      this.settle(new Error('speaker disconnected'))
      this.log('warn', 'speaker disconnected')
      this.emit()
    })
    socket.on('error', (error) => { this.log('warn', `speaker connection error: ${error.message}`) })
    void this.afterConnect()
  }

  private async afterConnect(): Promise<void> {
    try {
      this.status.clientVersion = String(await this.call('get_version', undefined, 5000) ?? '').trim() || undefined
      this.status.device = String((await this.shell(SHELL.model, 5000)).stdout ?? '').trim() || undefined
      this.emit()
    } catch { /* identity is cosmetic */ }
  }

  private addressAllowed(remote: string): boolean {
    const list = this.options.allowFrom
    if (list.length === 0) return true
    return list.some((entry) => {
      const want = entry.trim().replace(/^::ffff:/, '')
      return want !== '' && (remote === want || (want.endsWith('.') && remote.startsWith(want)))
    })
  }

  private tokenOk(url: string): boolean {
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    if (new URLSearchParams(query).get('token') === this.options.token) return true
    return url.split('?')[0]!.replace(/^\/|\/$/g, '') === this.options.token
  }

  private onText(frame: Record<string, unknown>): void {
    if (frame.Response !== undefined) return this.onResponse(frame.Response as { id?: string; code?: number | null; msg?: string; data?: unknown })
    if (frame.Event !== undefined) return this.onEvent(frame.Event as { event?: string; data?: unknown })
    if (frame.Request !== undefined) {
      // We register no commands, but must answer or the client waits for its timeout.
      const id = String((frame.Request as { id?: unknown }).id ?? '')
      this.sendText({ Response: { id, code: -1, msg: 'command not found' } })
    }
  }

  private onStream(frame: Record<string, unknown>): void {
    if (frame.tag !== 'record') return
    const bytes = frame.bytes
    if (!Array.isArray(bytes) || bytes.length === 0) return
    this.hooks.audio?.(Uint8Array.from(bytes as number[]))
  }

  private onResponse(response: { id?: string; code?: number | null; msg?: string; data?: unknown }): void {
    const pending = this.pending.get(String(response.id ?? ''))
    if (pending === undefined) return
    this.pending.delete(String(response.id))
    clearTimeout(pending.timer)
    if (response.code !== undefined && response.code !== null && response.code !== 0) pending.reject(new Error(`speaker refused: ${response.msg ?? response.code}`))
    else pending.resolve(response.data)
  }

  private onEvent(event: { event?: string; data?: unknown }): void {
    switch (event.event) {
      case 'kws': {
        const data = event.data as { Keyword?: string } | string | undefined
        const word = typeof data === 'object' && data !== null ? String(data.Keyword ?? '') : ''
        if (word) this.hooks.keyword?.(word)
        return
      }
      case 'playing': {
        const raw = String(event.data ?? '').toLowerCase()
        this.status.playing = raw.startsWith('play') ? 'playing' : raw.startsWith('pause') ? 'paused' : 'idle'
        this.hooks.playing?.(this.status.playing)
        this.emit()
        return
      }
      case 'instruction': {
        const line = (event.data as { NewLine?: unknown } | undefined)?.NewLine
        if (typeof line !== 'string') return
        let message: { header?: { namespace?: string; name?: string; id?: string }; payload?: { is_final?: boolean; results?: { text?: string }[] } }
        try { message = JSON.parse(line) } catch { return }
        if (message.header?.namespace !== 'SpeechRecognizer' || message.header.name !== 'RecognizeResult') return
        const final = message.payload?.is_final === true
        const id = String(message.header.id ?? '')
        // A restart of XiaoAI's service replays the last result; one final per id.
        if (final && id) {
          if (this.seenFinals.has(id)) return
          this.seenFinals.add(id)
          if (this.seenFinals.size > 300) this.seenFinals = new Set([...this.seenFinals].slice(-150))
        }
        this.hooks.recognizer?.(String(message.payload?.results?.[0]?.text ?? '').trim(), final, id)
        return
      }
      default:
    }
  }

  // ---------------------------------------------------------------------------------------------- outbound
  private sendText(frame: unknown): void {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) throw new Error('the speaker is not connected')
    socket.send(JSON.stringify(frame))
  }

  private sendStream(tag: string, bytes: Uint8Array): void {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) throw new Error('the speaker is not connected')
    socket.send(Buffer.from(JSON.stringify({ id: randomUUID(), tag, bytes: Array.from(bytes) })), { binary: true })
  }

  /** Call a client command and wait for its response. */
  call(command: string, payload?: unknown, timeoutMs = 8000): Promise<unknown> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`speaker did not answer ${command} within ${timeoutMs} ms`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.sendText({ Request: { id, command, ...payload === undefined ? {} : { payload } } })
        this.status.commands += 1
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error as Error)
      }
    })
  }

  /** Run a fixed shell snippet on the speaker. Never pass outside text unquoted. */
  async shell(script: string, timeoutMs = 8000): Promise<{ stdout?: string; stderr?: string; exit_code?: number }> {
    return (await this.call('run_shell', script, timeoutMs) ?? {}) as { stdout?: string; stderr?: string; exit_code?: number }
  }

  async startRecording(): Promise<void> {
    await this.call('start_recording', audioConfig(16000), 5000)
    this.status.recording = true
    this.emit()
  }

  /** Interrupt XiaoAI (restart its dialog service), as upstream's `abort_xiaoai`. */
  async interrupt(): Promise<void> { await this.shell(SHELL.abort, 6000) }

  /**
   * Play 16-bit mono PCM at `sampleRate`, streamed as it arrives. Pushed at most `playLeadMs` ahead of real time:
   * the client's player drops a write that stalls for more than 100 ms, so flooding it loses audio. Plays one at a
   * time; resolves when the audio has been played out.
   */
  play(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, sampleRate = TTS_RATE, signal?: AbortSignal): Promise<{ ms: number }> {
    const run = async (): Promise<{ ms: number }> => {
      this.status.speaking = true
      this.emit()
      let sentMs = 0
      let started = 0
      try {
        await this.call('start_play', audioConfig(sampleRate), 5000)
        started = Date.now()
        for await (const piece of source) {
          for (const part of chunks(piece, 100, sampleRate)) {
            if (signal?.aborted) throw signal.reason ?? new Error('aborted')
            const ahead = sentMs - (Date.now() - started)
            if (ahead > this.options.playLeadMs) await sleep(ahead - this.options.playLeadMs)
            this.sendStream('play', part)
            sentMs += durationMs(part.byteLength, sampleRate)
          }
        }
        const left = sentMs - (Date.now() - started)
        if (left > 0) await sleep(left + 150)
        return { ms: sentMs }
      } finally {
        await this.call('stop_play', undefined, 3000).catch(() => undefined)
        this.status.speaking = false
        this.emit()
      }
    }
    const next = this.playChain.then(run, run)
    this.playChain = next.catch(() => undefined)
    return next
  }

  /** XiaoAI's own voice: `tts_play.sh '<text>'`. The script's exit code lies (see the README), so judge by its output. */
  async nativeSay(text: string): Promise<{ ok: boolean; note: string }> {
    const wrapper = `${SHELL.playText(shellQuote(text))}; printf '\\n__RC=%s\\n' "$?"`
    const result = await this.shell(wrapper, 20000)
    const out = String(result.stdout ?? '')
    const rc = Number(/__RC=(-?\d+)/.exec(out)?.[1] ?? result.exit_code ?? -1)
    const madeAudio = /\.(?:opus|wav|mp3|ogg|pcm|flac)\b/i.test(out)
    if (rc !== 0 && !madeAudio) return { ok: false, note: `tts_play.sh failed (exit ${rc}) ${String(result.stderr ?? '').slice(0, 100)}`.trim() }
    return { ok: true, note: 'played with the speaker’s own voice' }
  }

  /** Restart the client on the speaker (it then reconnects); for a client that is connected but deaf. */
  async restartClient(): Promise<{ ok: boolean; note: string }> {
    if (!this.connected) return { ok: false, note: 'the speaker is not connected' }
    const url = this.options.advertise.trim()
    if (!url) return { ok: false, note: 'advertise (the ws:// URL the client dials) is not configured' }
    const before = this.status.connects
    const script = 'kill -9 `ps | grep "open-xiaoai/client" | grep -v grep | awk \'{print $1}\'` >/dev/null 2>&1 || true; '
      + `sleep 1; nohup /data/open-xiaoai/client ${shellQuote(url)} </dev/null >/dev/null 2>&1 & echo restarted`
    try { await this.shell(script, 6000) } catch { /* it killed the connection the answer would travel on */ }
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      if (this.status.connects > before && this.connected) return { ok: true, note: `client restarted and reconnected (connection #${this.status.connects})` }
      await sleep(500)
    }
    return { ok: false, note: 'restart sent, but the client did not reconnect within 25 s' }
  }

  async probe(): Promise<Record<string, string | undefined>> {
    if (!this.connected) return {}
    const pick = async (run: () => Promise<string>) => { try { return (await run()).trim() || undefined } catch { return undefined } }
    return {
      device: await pick(async () => String((await this.shell(SHELL.model)).stdout ?? '')),
      version: await pick(async () => String(await this.call('get_version') ?? '')),
      boot: await pick(async () => String((await this.shell(SHELL.boot)).stdout ?? '')),
    }
  }

  private settle(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
  }

  private fail(note: string): void {
    this.status.lastError = note
    this.log('warn', note)
    this.emit()
  }

  private log(level: 'info' | 'warn', message: string): void { this.hooks.log?.(level, message) }

  private emit(): void { try { this.hooks.state?.(this.snapshot()) } catch { /* observer errors are not ours */ } }
}
