/**
 * `dsh-plugin-orange`: 橘波特 on the DeepSeek Harness IM host.
 *
 * The bot's sessions are not created here: dsh-im-dispatch runs one router per chat and starts task workers through
 * dsh-im-session-tasks, and dsh-plugin-orange-voice runs the speaker session. This plugin gives all of them the
 * bot's character and knowledge, through public APIs only:
 *
 * - the `orange:persona` system-prompt section (persona, owner, projects, the chat's profile and workspace
 *   `AGENTS.md`, known people, long-term memory), rendered for every session `ctx.im.sessions` hosts;
 * - the tools in `tools.ts` (memory, user tags, project repos, PR/issue links, model tiers, chat profiles);
 * - a tool guard over file/shell calls of hosted sessions, an `im/before-send` leak guard for private projects, and
 *   an `im/message` filter that keeps plain abuse away from every session;
 * - token usage accounting from `session/event`, GitHub feedback into the linked task workers, a one-time import
 *   of the v1 export, and three dsh-im-panel tabs.
 *
 * The service (`ctx.orange`) exposes the store and the effective settings to companion plugins.
 *
 * @module dsh-plugin-orange
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImApi, ImMessageEvent, ImOutcome, ImOutgoing, ImMessage } from '@deepseek-ai/dsh-im'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ImTasks } from 'dsh-im-session-tasks'
import { Config } from './config.ts'
import { orangeDomain, type OrangeDomain } from './domain.ts'
import { startPoller } from './github.ts'
import { importV1, type StickerSink } from './import-v1.ts'
import { applyPanel } from './panel.ts'
import { personaSection } from './persona.ts'
import { compilePatterns, fragmentText, GUARDED_TOOLS, hardInsult, leakReason, sensitiveReason } from './privacy.ts'
import { effective, homeChat, isAdmin, profileOf, projectsFor, roleOf, type Effective, type HostedLike } from './roles.ts'
import { OrangeStore, pathSafeTable, type OrangeTables, type Table } from './store.ts'
import { applyTools } from './tools.ts'
import { usageOf } from './usage.ts'
import { agentsText } from './workspace.ts'

export { Config } from './config.ts'
export type { AssistTopic, ChatProfile, OwnProject } from './config.ts'
export { CHAT_PERSONA, TASK_PERSONA, VOICE_PERSONA, personaSection } from './persona.ts'
export { effective, homeChat, isAdmin, roleOf, VOICE_OWNER } from './roles.ts'
export type { Effective, OrangeRole } from './roles.ts'
export { OrangeStore, memoryTables } from './store.ts'
export type { MemoryRecord, UserRecord, UsageRecord } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 橘波特: its store and effective settings. */
    orange: OrangeService
  }
}

/** Section name of the persona in the system prompt; order 50 sits after the deployment persona prefix (0). */
export const PERSONA_SECTION = 'orange:persona'

export class OrangeService extends Service {
  static inject = ['im', 'storageDomain', 'tools', 'systemPrompt']
  static Config = Config

  private readonly home: Context
  private domain: OrangeDomain | undefined
  private storeValue: OrangeStore | undefined

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'orange')
    this.home = ctx
  }

  /** The bot's store; throws until the domain is open. */
  get store(): OrangeStore {
    if (this.storeValue === undefined) throw new Error('orange store is not open yet')
    return this.storeValue
  }

  /** Config seeds with the panel's settings on top. */
  settings(): Effective { return effective(this.config, this.storeValue?.settings()) }

  /** Whether a platform user is an admin. */
  isAdmin(user: string | undefined, bot?: string): boolean { return isAdmin(this.config.admins, user, bot) }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const ctx = this.home
    const logger = ctx.logger('orange')
    const im = ctx.im as unknown as ImApi
    const domain = await ctx.storageDomain.open(orangeDomain)
    this.domain = domain
    // per-record keys become file names: arbitrary keys (usage day|kind|model, owner/repo#n) are encoded.
    const safe = <T>(table: unknown) => pathSafeTable(table as Table<unknown>) as unknown as T
    const store = new OrangeStore({
      memory: safe(domain.table('memory')),
      users: safe(domain.table('users')),
      settings: safe(domain.table('settings')),
      usage: safe(domain.table('usage')),
      links: safe(domain.table('links')),
      state: safe(domain.table('state')),
    } as OrangeTables)
    this.storeValue = store
    let stopPoller: (() => void) | undefined
    yield async () => {
      stopPoller?.()
      this.storeValue = undefined
      this.domain = undefined
      await domain.close()
    }

    const config = this.config
    const settings = () => this.settings()
    const tasks = () => ctx.get('imTasks' as never) as ImTasks | undefined
    const recordOf = (sessionId: string | undefined): HostedLike | undefined =>
      sessionId === undefined ? undefined : (im.sessions.of(sessionId as never) as HostedLike | undefined)

    // ---- persona ------------------------------------------------------------------------------------------
    ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: 50,
      interpolate: false,
      text: (context) => {
        const agent = (context as { agent?: { session: { id: string } } }).agent
        const record = recordOf(agent?.session.id)
        if (record === undefined) return ''
        const role = roleOf(record)
        const chat = homeChat(record)
        const current = settings()
        const profile = profileOf(current.chats, chat)
        const chatName = profile?.name ?? (chat === undefined ? undefined : im.chat(chat as never)?.ref.name)
        const people = store.users().filter((u) => u.chat === chat && (u.tags.length > 0 || u.note)).slice(0, 30)
        const adminNames = [...new Set(current.admins.map((id) => store.user(id)?.name).filter((n): n is string => !!n))]
        const agents = role === 'worker' ? agentsText(profile?.workspace, config.maxAgentsChars) : undefined
        return personaSection({
          role,
          settings: current,
          ...chat === undefined ? {} : { chat },
          ...chatName ? { chatName } : {},
          ...profile ? { profile } : {},
          projects: projectsFor(current, chat),
          facts: store.promptFacts(chat, config.memory.promptFacts),
          people,
          adminNames,
          ...agents ? { agents } : {},
          tiers: Object.entries(config.taskModels).filter(([, route]) => route !== undefined).map(([tier]) => tier),
        })
      },
    })

    // ---- tools --------------------------------------------------------------------------------------------
    applyTools(ctx, {
      im,
      store,
      config,
      settings,
      tasks,
      workspaceRoot: (chat) => profileOf(settings().chats, chat)?.workspace ?? config.workspace,
    })

    // ---- tool guard ---------------------------------------------------------------------------------------
    if (config.guard.enabled) {
      const extra = compilePatterns(config.guard.patterns, (message) => logger.warn(message))
      ctx.effect(() => ctx.tools.guard((exec) => {
        if (!GUARDED_TOOLS.has(String(exec.name))) return undefined
        if (recordOf((exec as { agent?: { session: { id: string } } }).agent?.session.id) === undefined) return undefined
        const hit = sensitiveReason(exec.arguments, extra)
        if (hit === undefined) return undefined
        logger.warn('tool guard refused %s (%s): %s', exec.name, hit.what, JSON.stringify(exec.arguments).slice(0, 200))
        return hit.reason
      }), 'orange: tool guard')
    }

    // ---- private-project leak guard -----------------------------------------------------------------------
    if (config.leak.enabled) {
      ctx.on('im/before-send', async (outgoing: ImOutgoing, next) => {
        try {
          const current = settings()
          if (current.projects.some((p) => p.private)) {
            const text = `${fragmentText(outgoing.content)} ${fragmentText(outgoing.original)}`
            const reason = leakReason(text, outgoing.chat, current.projects, current.admins)
            if (reason !== undefined) {
              outgoing.drop = reason
              logger.warn('leak guard held back a message to %s', outgoing.chat)
            }
          }
        } catch (error) {
          logger.warn('leak guard failed: %s', String(error))
        }
        return next()
      })
    }

    // ---- abuse filter, people -----------------------------------------------------------------------------
    ctx.on('im/message', async (event: ImMessageEvent, next: () => Promise<ImOutcome>) => {
      const message = event.message
      if (!message.sender.self && !this.isAdmin(message.sender.id, message.chat.bot) && hardInsult(message.text)) {
        return { kind: 'ignored', reason: 'orange: abuse' }
      }
      return next()
    }, { prepend: true })
    ctx.on('im/stored', (message: ImMessage) => {
      if (message.sender.self) return
      void store.seen(message.sender.id, message.sender.name, message.chat.key).catch(() => {})
    })

    // ---- usage --------------------------------------------------------------------------------------------
    ctx.on('session/event', (session, event) => {
      const record = recordOf(String(session.id))
      if (record === undefined) return
      const usage = usageOf(event, (stream) => (lastAssistantStreamChunk(stream as never, 'usage') as { usage?: never } | undefined)?.usage)
      if (usage === undefined) return
      const kind = `${roleOf(record)}${record.sessionId === String(session.id) ? '' : '-subagent'}`
      void store.addUsage({ kind, ...usage }).catch((error: unknown) => logger.warn('usage: %s', String(error)))
    })

    // ---- GitHub follow-ups --------------------------------------------------------------------------------
    if (config.github.enabled) {
      stopPoller = startPoller({
        store,
        log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
        deliver: async (taskId, session, text, id) => {
          const target = tasks()?.get(taskId)?.session ?? session
          if (im.sessions.get(target) === undefined) return false
          await im.sessions.deliver(target, { id, mode: 'steer', content: [{ type: 'text', text }] })
          return true
        },
      }, config.github.intervalMs)
    }

    // ---- v1 import ----------------------------------------------------------------------------------------
    if (config.importV1) {
      const dir = config.importV1
      void (async () => {
        await (ctx.get('loader' as never) as { await?: () => Promise<void> } | undefined)?.await?.()
        const report = await importV1(dir, store, ctx.get('imStickers' as never) as StickerSink | undefined)
        if (report.skipped) return
        logger.info('v1 import: %d facts, %d people, %d stickers', report.memory, report.users, report.stickers)
        for (const error of report.errors.slice(0, 20)) logger.warn('v1 import: %s', error)
      })().catch((error: unknown) => logger.warn('v1 import failed: %s', String(error)))
    }

    applyPanel(ctx, { store, config, settings })
    logger.info('orange: mounted (%d admins, %d projects)', config.admins.length, settings().projects.length)
  }
}

export const name = 'orange'
export default OrangeService
