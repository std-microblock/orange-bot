/**
 * `dsh-plugin-orange-voice`: a XiaoAI speaker (open-xiaoai patched firmware) as the owner's voice channel to 橘波特.
 *
 * The speaker is a source next to dsh-im, not inside it: its utterances are not platform messages (no message id,
 * nothing to quote or passively reply to), so they do not go through `im/message`. Instead the plugin hosts one
 * session of its own through the public `ctx.im.sessions` API (key `orange-voice:main`, owner `orange-voice`),
 * bound to the owner's direct chat when one is configured, and delivers every accepted transcript into it as a
 * durable steer. The session answers with `speak`; it can also write into the owner's chat with the IM tools and
 * start background tasks (`task_start`, when `orange-voice` is one of dsh-im-session-tasks' owners).
 *
 * @module dsh-plugin-orange-voice
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImApi, ImSessionRecord } from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import { VoiceChannel, type Transcript } from './voice.ts'

export { Config } from './config.ts'
export { MIC_RATE, rms, TTS_RATE, Vad, wav } from './audio.ts'
export { asr, tts, DeepSeekError } from './deepseek.ts'
export { WakeGate } from './gate.ts'
export { audioConfig, shellQuote, SpeakerLink, speakable } from './speaker.ts'
export { VoiceChannel } from './voice.ts'

export const VOICE_OWNER = 'orange-voice'
export const PROMPT_SECTION = 'orange-voice:speak'

declare module '@deepseek-ai/cordis' {
  interface Context {
    orangeVoice: OrangeVoiceService
  }
}

/** The model-facing envelope of one transcript. */
export function envelope(t: Transcript, speaker: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const time = new Date(t.at)
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  return `<voice from="${escape(speaker)}" time="${hhmm}" via="${t.via}">${escape(t.text)}</voice>`
}

export const VOICE_PROMPT = `## 小爱音箱
<voice> 开头的消息是主人对着家里的小爱音箱说的话（语音识别结果，可能有错字）。你的普通回复文本谁都听不见，也不会发到任何聊天里：
- 要回答就调用 speak，像说话一样一两句、口语，不念链接、路径、代码、表格；说完这一轮就结束
- 内容长或需要留底（链接、步骤、清单）时，speak 一句简短结论，详细的用 im_send 发到主人私聊
- 查证、动手的活用 task_start 交给后台任务；任务完成后会通知你，再用 speak 简短告诉主人
- 只是噪音、识别不出意思、不是对你说的话，就什么都不调，直接结束
- 音箱离线时 speak 会失败，那就改用 im_send 发到主人私聊`

type Text = { type: 'text'; text: string }
const TEXT = { schema: { type: 'string' as const }, render: (_a: unknown, v: string): Text[] => [{ type: 'text', text: v }] }

export class OrangeVoiceService extends Service {
  static inject = ['im', 'tools', 'systemPrompt']
  static Config = Config

  private readonly home: Context
  channel: VoiceChannel | undefined

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'orangeVoice')
    this.home = ctx
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const ctx = this.home
    const logger = ctx.logger('orange-voice')
    const config = this.config
    if (!config.enabled) {
      logger.info('orange-voice: disabled (enabled: false)')
      return
    }
    const im = ctx.im as unknown as ImApi
    const key = config.session.key
    const chat = config.session.chat
    const ensure = () => im.sessions.ensure({
      key,
      owner: VOICE_OWNER,
      composition: config.session.composition,
      bindings: chat ? [{ chat: chat as never, writable: true, home: true }] : [],
      output: 'none',
      meta: { voice: true },
    })
    const channel = new VoiceChannel(config, {
      log: (level, message) => { if (level === 'warn') logger.warn(message); else logger.info(message) },
      deliver: async (transcript) => {
        await ensure()
        await im.sessions.deliver(key, {
          id: `voice:${transcript.id}`,
          mode: 'steer',
          content: [{ type: 'text', text: envelope(transcript, config.session.speaker) }],
        })
      },
    })
    this.channel = channel
    try {
      await channel.start()
    } catch (error) {
      logger.warn('orange-voice: speaker channel not listening: %s', String(error))
    }
    yield async () => {
      this.channel = undefined
      await channel.stop()
    }
    if (!config.deepseek.apiKey) logger.warn('orange-voice: no DeepSeek API key configured; ASR/TTS calls will be refused unless a relay adds one')
    if (config.allowFrom.length === 0) logger.warn('orange-voice: allowFrom is empty; anyone reaching port %d can drive the speaker', config.port)

    /** Whether a session may use the speaker: the voice session, its tasks and subagents, or the owner's chat. */
    const allowed = (exec: ToolRunContext): ImSessionRecord | undefined => {
      const id = exec.agent?.session.id
      let record = id === undefined ? undefined : im.sessions.of(id)
      for (let i = 0; record !== undefined && i < 8; i++) {
        if (record.owner === VOICE_OWNER) return record
        if (chat && record.bindings.some((b) => b.chat === chat)) return record
        record = record.parent === undefined ? undefined : im.sessions.get(record.parent)
      }
      return undefined
    }

    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'speak',
      description: 'Say something out loud through the owner\'s XiaoAI speaker (DeepSeek TTS). Spoken style: one or two short '
        + 'sentences, no links, paths, code or tables. Only the voice session, its tasks and the owner\'s direct chat may use it.',
      parameters: {
        text: { type: 'string', required: true },
        interrupt: { type: 'boolean', description: 'Stop whatever the speaker is saying first.' },
      },
      output: TEXT,
      async execute(args, exec) {
        if (allowed(exec) === undefined) return 'speak is only available to the voice session and the owner\'s chat'
        const result = await channel.speak(String(args.text), { ...args.interrupt ? { interrupt: true } : {}, ...exec.signal ? { signal: exec.signal } : {} })
        return result.ok ? `${result.note}：「${result.spoken}」` : `not spoken: ${result.note}`
      },
    })), 'orange-voice: speak tool')

    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'speaker_status',
      description: 'The XiaoAI speaker: connected or not, what it heard lately (and why an utterance was dropped), what was spoken.',
      parameters: { probe: { type: 'boolean', description: 'Also ask the speaker for model, client version and boot slot.' } },
      output: TEXT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (allowed(exec) === undefined) return 'speaker_status is only available to the voice session and the owner\'s chat'
        const status = channel.status()
        const probed = args.probe ? await channel.link.probe() : undefined
        return JSON.stringify({ ...status, heard: status.heard.slice(0, 10), ...probed ? { probed } : {} })
      },
    })), 'orange-voice: speaker_status tool')

    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'speaker_recover',
      description: 'Restart the client on the speaker, for a speaker that stays connected but no longer hears anything.',
      parameters: {},
      output: TEXT,
      async execute(_args, exec) {
        if (allowed(exec) === undefined) return 'speaker_recover is only available to the voice session and the owner\'s chat'
        return (await channel.link.restartClient()).note
      },
    })), 'orange-voice: speaker_recover tool')

    ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: 52,
      interpolate: false,
      text: (context) => {
        const agent = (context as { agent?: { session: { id: string } } }).agent
        const record = agent === undefined ? undefined : im.sessions.of(agent.session.id as never)
        return record?.owner === VOICE_OWNER ? VOICE_PROMPT : ''
      },
    })

    ctx.inject(['imPanel' as never], (scoped) => {
      const panel = (scoped as unknown as { imPanel: { tab(definition: unknown): () => void } }).imPanel
      scoped.effect(() => panel.tab({
        id: 'orange-voice',
        title: '小爱音箱',
        order: 95,
        badge: () => (channel.link.connected ? undefined : 1),
        read: async ({ path }: { path: string }) => (path === 'probe' ? channel.link.probe() : { ...channel.status(), config: {
          host: config.host, port: config.port, allowFrom: config.allowFrom, token: config.token !== '', tts: config.tts,
          voice: config.deepseek.voice, baseUrl: config.deepseek.baseUrl, apiKey: config.deepseek.apiKey !== '',
          wake: config.wake, session: { key, chat: chat ?? '' },
        } }),
        command: async ({ body }: { body: unknown }) => {
          const c = (body ?? {}) as { action?: string; text?: string }
          if (c.action === 'speak') {
            const result = await channel.speak(String(c.text ?? ''))
            return { ok: result.ok, text: result.ok ? `已念：${result.spoken}` : result.note }
          }
          if (c.action === 'recover') { const r = await channel.link.restartClient(); return { ok: r.ok, text: r.note } }
          if (c.action === 'interrupt') { await channel.link.interrupt(); return { ok: true, text: '已打断' } }
          throw new Error(`unknown action ${String(c.action)}`)
        },
      }), 'orange-voice: panel tab')
    })
    logger.info('orange-voice: mounted (session %s%s, tts %s)', key, chat ? ` bound to ${chat}` : '', config.tts)
  }
}

export const name = 'orange-voice'
export default OrangeVoiceService
