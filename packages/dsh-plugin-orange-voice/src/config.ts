/**
 * Configuration of the voice plugin row (zod).
 *
 * @module dsh-plugin-orange-voice/config
 */
import { z } from 'zod'

const composition = z.object({
  agentPreset: z.string(),
  provider: z.string(),
  model: z.string(),
  cwd: z.string(),
  /** Tools the voice session keeps visible (`allow`) or loses (`deny`). */
  restrict: z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).optional(),
})

export const Config = z.object({
  /** Off by default: nothing listens until a deployment turns it on. */
  enabled: z.boolean().default(false),
  /** Where the open-xiaoai client connects (`ws://<host>:<port>`, the speaker's `server.txt`). */
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(0).max(65535).default(4399),
  /**
   * Source addresses allowed to connect (exact IP, or a prefix ending in `.`). The protocol has no authentication and
   * `run_shell` is root on the speaker, so this list is the real gate; empty = anyone who reaches the port.
   */
  allowFrom: z.array(z.string()).default([]),
  /** Optional token (`?token=` or the URL path); the stock client sends none, so leave it empty for it. */
  token: z.string().default(''),

  /** The hosted session transcripts go to. */
  session: z.object({
    /** Stable `ctx.im.sessions` key. */
    key: z.string().default('orange-voice:main'),
    /** Composition of the voice session (preset, route, working directory). */
    composition,
    /**
     * Chat key of the owner's direct chat (`qq:<appId>|user:<openid>`): bound writable and home, so the session can
     * also write there, and sessions serving that chat may use `speak`. Optional.
     */
    chat: z.string().optional(),
    /** Who the transcript says is talking. */
    speaker: z.string().default('主人（音箱）'),
  }),

  /** DeepSeek tool APIs (ASR + TTS). The key is injected by the host relay in deployment; never commit one. */
  deepseek: z.object({
    baseUrl: z.string().default('https://api.deepseek.com'),
    apiKey: z.string().default(''),
    /** `stella` (female, default) or `tide` (male). */
    voice: z.string().default('stella'),
    asrTimeoutMs: z.number().int().min(1000).default(60000),
    ttsTimeoutMs: z.number().int().min(1000).default(60000),
  }).default({ baseUrl: 'https://api.deepseek.com', apiKey: '', voice: 'stella', asrTimeoutMs: 60000, ttsTimeoutMs: 60000 }),

  /** `deepseek`: synthesize on the VM and stream PCM to the speaker; `native`: the speaker's own `tts_play.sh`. */
  tts: z.enum(['deepseek', 'native']).default('deepseek'),
  /** Fall back to `tts_play.sh` when DeepSeek TTS fails. */
  ttsFallback: z.boolean().default(true),

  /** When an utterance counts as addressed to the bot. */
  wake: z.object({
    /** The client's custom wake-word events (`kws`, sherpa-onnx on the speaker) open a listening window. */
    kws: z.boolean().default(true),
    /** Which keywords count (empty = every keyword the speaker reports). */
    wakeWords: z.array(z.string()).default([]),
    /** XiaoAI's own wake ("小爱同学"), seen in its instruction log, opens a window too. */
    native: z.boolean().default(true),
    /** Utterances XiaoAI should keep (device control): a leading word in its own recognition result. */
    bypassPrefixes: z.array(z.string()).default(['小爱']),
    /** Leading words that address the bot; stripped before delivery. */
    prefixes: z.array(z.string()).default(['让橘波特', '橘波特', '橘子']),
    /**
     * Transcribe every utterance even outside a window and accept the ones starting with a prefix. Costs one ASR
     * request per utterance in the room (the transcript of a rejected one is discarded, never stored).
     */
    alwaysListen: z.boolean().default(false),
    /** How long a wake keeps the window open. */
    windowMs: z.number().int().min(1000).default(12000),
    /** After the bot speaks, the next utterance within this time needs no wake word (follow-up). 0 = off. */
    followUpMs: z.number().int().min(0).default(15000),
    /** How long to wait for XiaoAI's final recognition result when deciding about a native wake. */
    nativeWaitMs: z.number().int().min(0).default(2500),
  }).default({
    kws: true, wakeWords: [], native: true, bypassPrefixes: ['小爱'], prefixes: ['让橘波特', '橘波特', '橘子'],
    alwaysListen: false, windowMs: 12000, followUpMs: 15000, nativeWaitMs: 2500,
  }),

  /** Energy VAD over the 16 kHz mono stream. */
  vad: z.object({
    /** Absolute RMS floor (of 32768) below which nothing is speech. */
    minRms: z.number().min(0).default(350),
    /** Speech = RMS above `ratio` × the tracked noise floor. */
    ratio: z.number().min(1).default(3),
    /** Speech has to last this long to start an utterance. */
    startMs: z.number().int().min(0).default(90),
    /** Silence that ends an utterance. */
    silenceMs: z.number().int().min(100).default(700),
    /** Shorter utterances are dropped (coughs, clicks). */
    minSpeechMs: z.number().int().min(0).default(400),
    /** Longest utterance (the ASR API takes 120 s). */
    maxUtteranceMs: z.number().int().min(1000).max(115000).default(30000),
    /** Audio kept from before the speech started. */
    preRollMs: z.number().int().min(0).default(300),
  }).default({ minRms: 350, ratio: 3, startMs: 90, silenceMs: 700, minSpeechMs: 400, maxUtteranceMs: 30000, preRollMs: 300 }),

  /** Interrupt XiaoAI's own answer when an utterance is ours. */
  takeover: z.boolean().default(true),
  /** Characters `speak` reads at most. */
  maxSpeakChars: z.number().int().min(10).default(300),
  /** How far ahead of real time PCM is pushed to the speaker (its player drops writes stalled > 100 ms). */
  playLeadMs: z.number().int().min(100).default(400),
  /** The `ws://…` the speaker client connects to; `speaker_recover` restarts the client with it. */
  advertise: z.string().default(''),
})
export type Config = z.output<typeof Config>
