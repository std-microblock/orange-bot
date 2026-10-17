/**
 * dsh-plugin-orange host entry. Mounted once on the Web host; it owns the bot
 * engine and the panel API. The agent tools are a separate preset row
 * (`dsh-plugin-orange/tools`) so the orange preset gives them to chat, task,
 * and subagent sessions alike.
 */
import type { Context } from '@deepseek-ai/cordis'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import { Config } from './config.ts'
import { OrangeBot } from './bot.ts'
import { registerWebApi } from './web.ts'
import { startNotificationPoller } from './github.ts'
import { setBot } from './registry.ts'
import { backfillUsage } from './backfill.ts'
import { GUARDED_TOOLS, sensitiveReason } from './privacy.ts'
import { createLog } from './log.ts'

export { Config }
export const name = 'orange'
export const inject = ['agents', 'agentPresets', 'workspaceRegistry', 'permissionPresets', 'sessionTitle', 'sessionPersistence', 'attachments', 'tools']

/** Root orange session id of a session (walks subagent lineage), or undefined. */
function orangeRoot(ctx: any, bot: OrangeBot, session: any): { id: string, role: string, conv: string } | undefined {
  for (let i = 0; session && i < 8; i++) {
    const id = String(session.id)
    const role = bot.store.get<{ role: string, conv: string } | undefined>(`role:${id}`, undefined)
    if (role) return { id, ...role }
    const parent = session.header?.parentSession
    session = parent ? (ctx.sessions?.get?.(parent) ?? ctx.agents.get(parent)?.session) : undefined
  }
  return undefined
}

export function apply(ctx: Context, config: Config) {
  let bot: OrangeBot | undefined
  registerWebApi(ctx, () => bot)
  // Hard floor under the prompt rules: no orange session — chat, task or subagent —
  // may read the bot's own database, credentials or session transcripts, however the
  // request is phrased. The guard sees the serialized arguments of every file/shell
  // call, so a base64-encoded path is the only way around it, and the persona rules
  // cover that. Denials are logged for the operator.
  ctx.effect(() => {
    const tools = (ctx as any).tools
    const log = createLog(config.dataDir)
    if (!tools?.guard) {
      log.warn('tool guard unavailable: ctx.tools.guard is missing — private-data access is only covered by the prompt rules')
      return () => {}
    }
    log.info('tool guard active: no orange session may read the bot database, credentials or session transcripts')
    return tools.guard((exec: any) => {
      if (!bot || !GUARDED_TOOLS.has(String(exec.name))) return undefined
      if (!orangeRoot(ctx, bot, exec.agent?.session)) return undefined
      const hit = sensitiveReason(exec.arguments)
      if (!hit) return undefined
      bot.log.warn(`tool guard refused ${exec.name} (${hit.what}): ${JSON.stringify(exec.arguments).slice(0, 200)}`)
      return hit.reason
    })
  }, 'orange: tool guard')
  // cost accounting for every model request of orange sessions (chat, task, and their subagents)
  ctx.on('session/event' as any, (session: any, event: any) => {
    if (!bot || (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')) return
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
    const root = orangeRoot(ctx, bot, session)
    if (!root) return
    const usage = event.type === 'assistant/message'
      ? (event.data.usage ?? (lastAssistantStreamChunk(event.data.stream, 'usage') as any)?.usage)
      : (lastAssistantStreamChunk(event.data.stream, 'usage') as any)?.usage
    if (!usage) return
    const sub = String(session.id) !== root.id
    bot.store.recordLlm({
      kind: `${root.role}${sub ? '-subagent' : ''}`,
      model: event.data.message?.source?.model ?? config.llm.agentModel,
      input: (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      cached: usage.cacheReadTokens ?? 0,
      output: usage.outputTokens ?? 0,
      conv: root.conv,
      ref: String(session.id),
    })
  })
  // when each worker's current run began, for `/ai.bg`
  ctx.on('agent/status' as any, (payload: any) => {
    const id = payload?.agent?.session?.id
    if (bot && id !== undefined) bot.noteAgentStatus(String(id), String(payload.status))
  })
  ctx.on('agent/disposed' as any, (payload: any) => {
    const id = payload?.agent?.session?.id
    if (bot && id !== undefined) bot.noteAgentStatus(String(id), 'idle')
  })
  // a worker whose turn errored (API failure after retries, crash): the worker
  // itself is gone by then, so nobody would ever report — mark and notify here
  ctx.on('agent/error' as any, (payload: any) => {
    const id = payload?.agent?.session?.id
    if (!bot || id === undefined) return
    void bot.taskWorkerFailed(String(id), payload.error).catch((e) => bot?.reportError('task failure notice', e))
  })
  ctx.effect(() => {
    let stopPoller: (() => void) | undefined
    let disposed = false
    void (async () => {
      await (ctx as any).get('loader')?.await()
      if (disposed) return
      bot = new OrangeBot(ctx, config)
      setBot(bot)
      bot.start()
      stopPoller = startNotificationPoller(bot)
      // only sessions that existed before live accounting (first boot of this version)
      if (!bot.store.get<boolean>('usage:live', false)) {
        await backfillUsage(bot, (process.env.HOME ?? '') + '/.dsh/sessions').catch(() => {})
        bot.store.set('usage:live', true)
      }
      bot.log.info('orange bot started')
    })().catch((error) => process.stderr.write(`orange start failed: ${(error as Error).stack}\n`))
    return () => {
      disposed = true
      stopPoller?.()
      bot?.stop()
      setBot(undefined)
      bot = undefined
    }
  }, 'orange: bot')
}
