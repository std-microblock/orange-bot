import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket } from 'ws'

import { concat, durationMs, rms, Vad, wav, type Utterance } from '../src/audio.ts'
import { Config } from '../src/config.ts'
import { asr, tts } from '../src/deepseek.ts'
import { WakeGate } from '../src/gate.ts'
import { audioConfig, shellQuote, speakable } from '../src/speaker.ts'
import { VoiceChannel, type Transcript } from '../src/voice.ts'

/** 30 ms of 16 kHz PCM: a tone at `amplitude`, or silence. */
function packet(amplitude: number, ms = 30, rate = 16000): Uint8Array {
  const samples = (rate * ms) / 1000
  const out = new Uint8Array(samples * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / rate)), true)
  return out
}

const VAD = { minRms: 350, ratio: 3, startMs: 90, silenceMs: 600, minSpeechMs: 300, maxUtteranceMs: 10000, preRollMs: 150 }

test('audio: wav header and rms', () => {
  const pcm = packet(1000)
  const file = wav(pcm)
  assert.equal(new TextDecoder().decode(file.subarray(0, 4)), 'RIFF')
  assert.equal(new TextDecoder().decode(file.subarray(8, 12)), 'WAVE')
  assert.equal(new DataView(file.buffer).getUint32(24, true), 16000)
  assert.equal(new DataView(file.buffer).getUint32(40, true), pcm.byteLength)
  assert.ok(Math.abs(rms(pcm) - 1000 / Math.SQRT2) < 20)
  assert.equal(rms(packet(0)), 0)
  assert.equal(durationMs(32000), 1000)
})

test('vad: one utterance with pre-roll, short noises dropped', () => {
  let clock = 0
  const got: Utterance[] = []
  const vad = new Vad(VAD, (u) => got.push(u), () => clock)
  const feed = (amplitude: number, ms: number) => { for (let t = 0; t < ms; t += 30) { clock += 30; vad.push(packet(amplitude + (t % 60 === 0 ? 3 : 0))) } }
  feed(20, 600) // room noise sets the floor
  feed(3000, 900) // speech
  feed(20, 900) // silence ends it
  assert.equal(got.length, 1)
  assert.ok(got[0]!.durationMs > 900 && got[0]!.durationMs < 1500, `duration ${got[0]!.durationMs}`)
  feed(3000, 120) // a click: too short
  feed(20, 900)
  assert.equal(got.length, 1)
  vad.mute(true)
  feed(3000, 900)
  feed(20, 900)
  assert.equal(got.length, 1, 'muted while the speaker talks')
})

test('gate: windows, prefixes, follow-up, native bypass', () => {
  let clock = 1000
  const gate = new WakeGate({ kws: true, wakeWords: ['橘波特'], native: true, bypassPrefixes: ['小爱'], prefixes: ['橘波特', '让橘波特'], alwaysListen: false, windowMs: 10000, followUpMs: 15000 }, () => clock)
  assert.deepEqual(gate.decide(clock), { action: 'drop', reason: 'no wake' })
  assert.equal(gate.keyword('小爱同学'), false)
  assert.equal(gate.keyword('你好橘波特'), true)
  clock += 3000
  assert.deepEqual(gate.decide(clock), { action: 'transcribe', via: 'kws', prefixOnly: false })
  assert.equal(gate.decide(clock).action, 'drop', 'one window, one utterance')
  assert.deepEqual(gate.accept('橘波特，今天天气怎么样', false), { text: '今天天气怎么样', prefixed: true })
  assert.equal(gate.accept('橘波特', false), undefined)
  gate.spoke()
  clock += 5000
  assert.equal(gate.decide(clock).action, 'transcribe')
  // native wake, then XiaoAI keeps a device command
  gate.nativeListening()
  assert.ok(gate.awaitingNative())
  assert.equal(gate.nativeResult('小爱 打开空调'), true)
  assert.equal(gate.decide(clock + 500).action, 'drop')
  clock += 20000
  gate.nativeListening()
  assert.equal(gate.nativeResult('早上好呀'), false)
  assert.equal(gate.decide(clock + 300).action, 'transcribe')
})

test('gate: always listening needs a prefix', () => {
  const gate = new WakeGate({ kws: true, wakeWords: [], native: false, bypassPrefixes: [], prefixes: ['橘波特'], alwaysListen: true, windowMs: 5000, followUpMs: 0 })
  const decision = gate.decide(Date.now())
  assert.deepEqual(decision, { action: 'transcribe', via: 'prefix', prefixOnly: true })
  assert.equal(gate.accept('今天吃什么', true), undefined)
  assert.deepEqual(gate.accept('橘波特 今天吃什么', true), { text: '今天吃什么', prefixed: true })
})

test('speaker text: speakable and shell quoting', () => {
  assert.equal(speakable('看 [这里](https://x.y/z) 和 **粗体** "引号"\\ [图片 #3.1]', 100), '看 这里 和 粗体 引号')
  assert.equal(speakable('一二三四五六七八九十', 5), '一二三四…')
  assert.equal(shellQuote(`a'b; rm -rf /`), `'a'\\''b; rm -rf /'`)
  assert.deepEqual(audioConfig(24000), { pcm: 'noop', channels: 1, bits_per_sample: 16, sample_rate: 24000, period_size: 240, buffer_size: 720 })
})

/** A fake DeepSeek tool API: ASR answers a fixed text, TTS streams PCM in pieces. */
async function fakeDeepSeek(options: { text: string; ttsBytes: number }) {
  const seen: { path: string; auth?: string; body: Buffer; type?: string }[] = []
  const server = createServer(async (request: IncomingMessage, response) => {
    const parts: Buffer[] = []
    for await (const chunk of request) parts.push(chunk as Buffer)
    const body = Buffer.concat(parts)
    seen.push({ path: request.url ?? '', ...request.headers.authorization ? { auth: request.headers.authorization } : {}, body, ...request.headers['content-type'] ? { type: request.headers['content-type'] } : {} })
    if (request.url === '/v1/tools/asr') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ request_id: 'r1', text: options.text, duration_ms: 1200 }))
      return
    }
    if (request.url === '/v1/tools/tts') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      const audio = Buffer.alloc(options.ttsBytes, 1)
      response.write(audio.subarray(0, 1001)) // odd split: the client must keep samples aligned
      setTimeout(() => response.end(audio.subarray(1001)), 20)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('deepseek: asr multipart and streamed tts', async () => {
  const api = await fakeDeepSeek({ text: '你好', ttsBytes: 4800 })
  try {
    const options = { baseUrl: `${api.base}/`, apiKey: 'test-key', voice: 'tide', asrTimeoutMs: 5000, ttsTimeoutMs: 5000 }
    const result = await asr(options, wav(packet(1000)))
    assert.equal(result.text, '你好')
    assert.equal(api.seen[0]?.auth, 'Bearer test-key')
    assert.match(api.seen[0]?.type ?? '', /multipart\/form-data/)
    assert.match(api.seen[0]!.body.toString('latin1'), /name="file"; filename="speech.wav"/)
    const pieces: Uint8Array[] = []
    for await (const piece of tts(options, '你好')) pieces.push(piece)
    assert.ok(pieces.every((p) => p.byteLength % 2 === 0))
    assert.equal(concat(pieces).byteLength, 4800)
    assert.deepEqual(JSON.parse(api.seen[1]!.body.toString()), { text: '你好', voice_id: 'tide', format: 'pcm', filter_markdown: true })
  } finally {
    await api.close()
  }
})

/** A fake open-xiaoai client: answers RPCs like the Rust client and records what it is sent. */
async function fakeSpeaker(url: string) {
  const ws = new WebSocket(url)
  const requests: { command: string; payload?: unknown }[] = []
  const played: number[] = []
  ws.on('message', (data, binary) => {
    const frame = JSON.parse(data.toString())
    if (binary) { if (frame.tag === 'play') played.push(frame.bytes.length); return }
    const request = frame.Request
    if (request === undefined) return
    requests.push({ command: request.command, payload: request.payload })
    const data2 = request.command === 'get_version' ? '1.0.0' : request.command === 'run_shell' ? { stdout: 'OH2P\n', stderr: '', exit_code: 0 } : undefined
    ws.send(JSON.stringify({ Response: { id: request.id, code: 0, msg: 'success', ...data2 === undefined ? {} : { data: data2 } } }))
  })
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  return {
    ws, requests, played,
    event: (event: string, data: unknown) => ws.send(JSON.stringify({ Event: { id: 'e', event, data } })),
    record: (pcm: Uint8Array) => ws.send(Buffer.from(JSON.stringify({ id: 's', tag: 'record', bytes: Array.from(pcm) })), { binary: true }),
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('voice channel: wake word → microphone → ASR → delivery, then speak → TTS → playback', async () => {
  const api = await fakeDeepSeek({ text: '橘波特，明天几点的会', ttsBytes: 24000 })
  const config = Config.parse({
    enabled: true, host: '127.0.0.1', port: 0, allowFrom: ['127.0.0.1'],
    session: { composition: { agentPreset: 'p', provider: 'x', model: 'y', cwd: '/tmp' } },
    deepseek: { baseUrl: api.base, apiKey: 'k' },
    wake: { wakeWords: ['橘波特'] },
    vad: VAD,
    takeover: false,
  })
  const delivered: Transcript[] = []
  const channel = new VoiceChannel(config, { deliver: async (t) => { delivered.push(t) }, log: () => {} })
  await channel.start().catch(async (error) => { await api.close(); throw error })
  const speaker = await fakeSpeaker(`ws://127.0.0.1:${channel.link.port()}`)
  try {
    await until(() => speaker.requests.some((r) => r.command === 'start_recording'))
    assert.deepEqual(speaker.requests.find((r) => r.command === 'start_recording')?.payload, audioConfig(16000))
    // speech without a wake word is not transcribed
    for (let i = 0; i < 20; i++) speaker.record(packet(20))
    for (let i = 0; i < 25; i++) speaker.record(packet(3000))
    for (let i = 0; i < 30; i++) speaker.record(packet(20))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(api.seen.length, 0)
    // after the wake word it is
    speaker.event('kws', { Keyword: '你好橘波特' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (let i = 0; i < 25; i++) speaker.record(packet(3000))
    for (let i = 0; i < 30; i++) speaker.record(packet(20))
    await until(() => delivered.length === 1)
    assert.equal(delivered[0]!.text, '明天几点的会')
    assert.equal(delivered[0]!.via, 'kws')
    assert.equal(api.seen[0]?.path, '/v1/tools/asr')

    const result = await channel.speak('**三点**，在 [会议室](https://x)')
    assert.equal(result.ok, true, result.note)
    assert.equal(result.spoken, '三点，在 会议室')
    const commands = speaker.requests.map((r) => r.command)
    assert.ok(commands.indexOf('start_play') < commands.lastIndexOf('stop_play'))
    assert.deepEqual(speaker.requests.find((r) => r.command === 'start_play')?.payload, audioConfig(24000))
    assert.equal(speaker.played.reduce((n, b) => n + b, 0), 24000)
    // a follow-up needs no wake word (once the echo guard after playback is over)
    await new Promise((resolve) => setTimeout(resolve, 600))
    for (let i = 0; i < 25; i++) speaker.record(packet(3000))
    for (let i = 0; i < 30; i++) speaker.record(packet(20))
    await until(() => delivered.length === 2)
    assert.equal(delivered[1]!.via, 'follow-up')
  } finally {
    speaker.ws.close()
    await channel.stop()
    await api.close()
  }
})

test('voice channel: refused sources and the native fallback', async () => {
  const config = Config.parse({
    enabled: true, host: '127.0.0.1', port: 0, allowFrom: ['10.9.9.9'],
    session: { composition: { agentPreset: 'p', provider: 'x', model: 'y', cwd: '/tmp' } },
  })
  const channel = new VoiceChannel(config, { deliver: async () => {}, log: () => {} })
  await channel.start()
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${channel.link.port()}`)
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)))
    assert.equal(code, 4403)
    assert.equal((await channel.speak('hi')).ok, false)
  } finally {
    await channel.stop()
  }
  // DeepSeek TTS unreachable → tts_play.sh
  const fallback = new VoiceChannel(Config.parse({
    enabled: true, host: '127.0.0.1', port: 0,
    session: { composition: { agentPreset: 'p', provider: 'x', model: 'y', cwd: '/tmp' } },
    deepseek: { baseUrl: 'http://127.0.0.1:9', ttsTimeoutMs: 2000 },
  }), { deliver: async () => {}, log: () => {} })
  await fallback.start()
  const speaker = await fakeSpeaker(`ws://127.0.0.1:${fallback.link.port()}`)
  try {
    await until(() => fallback.link.connected)
    const result = await fallback.speak("it's fine")
    assert.equal(result.engine, 'native')
    const shell = speaker.requests.filter((r) => r.command === 'run_shell').map((r) => String(r.payload)).find((p) => p.includes('tts_play.sh'))
    assert.match(shell ?? '', /tts_play\.sh 'it'\\''s fine'/)
  } finally {
    speaker.ws.close()
    await fallback.stop()
  }
})
