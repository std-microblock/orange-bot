/**
 * The bot's own tools, registered globally and usable from any session the IM host serves (routers keep only the
 * names their dispatch `tools.main` list names):
 *
 * | tool | who | |
 * |------|-----|-|
 * | `memory` | all | long-term facts: add / search / update / delete |
 * | `user_tag` | all | the `dev` tag and a note on a person |
 * | `project_repos` | all | the owner's projects with every repo and its workspace path |
 * | `task_link` | workers | link a PR/issue to the task, so GitHub feedback comes back to it |
 * | `task_tier` | workers | switch the worker to the fast / quality / vision model |
 * | `orange_chat` | admins | the current chat's profile: extra prompt, workspace, projects |
 *
 * @module dsh-plugin-orange/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImApi, ImSessionRecord } from '@deepseek-ai/dsh-im'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImTasks } from 'dsh-im-session-tasks'
import type { Config } from './config.ts'
import { projectTerms } from './privacy.ts'
import { homeChat, isAdmin, profileOf, projectsFor, roleOf, type Effective } from './roles.ts'
import { normalizeScope, USER_TAGS, type OrangeStore } from './store.ts'

export const ORANGE_TOOLS = ['memory', 'user_tag', 'project_repos', 'task_link', 'task_tier', 'orange_chat'] as const

export interface ToolDeps {
  im: ImApi
  store: OrangeStore
  config: Config
  settings: () => Effective
  tasks: () => ImTasks | undefined
  /** Where project repositories are checked out, for `project_repos` paths. */
  workspaceRoot: (chat: string | undefined) => string
}

const TEXT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** The calling session's hosted record, or a model-facing error. */
function caller(im: ImApi, exec: ToolRunContext): ImSessionRecord {
  const id = exec.agent?.session.id
  const record = id === undefined ? undefined : im.sessions.of(id)
  if (record === undefined) throw new Error('这个工具只能在 IM 会话里用')
  return record
}

/** Whether the message the session is answering was sent by an admin. */
export function triggeredByAdmin(im: ImApi, record: ImSessionRecord, admins: readonly string[]): boolean {
  let current: ImSessionRecord | undefined = record
  for (let i = 0; current !== undefined && i < 8; i++) {
    const trigger = im.sessions.trigger(current.sessionId)
    if (trigger !== undefined) return !trigger.sender.self && isAdmin(admins, trigger.sender.id, trigger.chat.bot)
    current = current.parent === undefined ? undefined : im.sessions.get(current.parent)
  }
  return false
}

export function applyTools(ctx: Context, deps: ToolDeps): void {
  const { im, store } = deps

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory',
    description: 'Long-term memory shared across sessions, filtered by scope. add stores a fact: scope chat (this chat, default), '
      + 'user:<platform user id> (a person), project:<name>, or global. search finds facts visible here (this chat, people, projects, '
      + 'global). update/delete change a fact by id. Facts of other chats are never visible.',
    parameters: {
      action: { type: 'string', enum: ['add', 'search', 'update', 'delete'], required: true },
      text: { type: 'string', description: 'The fact (add/update).' },
      scope: { type: 'string', description: 'chat | user:<id> | project:<name> | global (add/update; search narrows to it).' },
      query: { type: 'string', description: 'Words that must all appear (search).' },
      id: { type: 'integer', description: 'Fact id (update/delete).' },
    },
    output: TEXT,
    async execute(args, exec) {
      const record = caller(im, exec)
      const chat = homeChat(record)
      const admin = triggeredByAdmin(im, record, deps.settings().admins)
      if (args.action === 'add') {
        const row = await store.addMemory(normalizeScope(args.scope, chat), String(args.text ?? ''), chat)
        return `saved #${row.id} [${row.scope}]`
      }
      if (args.action === 'update' || args.action === 'delete') {
        const row = args.id === undefined ? undefined : store.memory(args.id)
        if (row === undefined) return `no fact #${args.id ?? '?'}`
        const own = row.scope === `chat:${chat}` || !row.scope.startsWith('chat:')
        if (!own && !admin) return `fact #${row.id} belongs to another chat`
        if (args.action === 'delete') { await store.deleteMemory(row.id); return `deleted #${row.id}` }
        const next = await store.updateMemory(row.id, {
          ...args.text ? { text: args.text } : {},
          ...args.scope ? { scope: normalizeScope(args.scope, chat) } : {},
        })
        return `updated #${row.id} [${next?.scope}] ${next?.text}`
      }
      const rows = store.memories({
        ...chat ? { chat } : {},
        all: admin && args.scope === 'all',
        ...args.query ? { query: args.query } : {},
        ...args.scope && args.scope !== 'all' ? { scope: normalizeScope(args.scope, chat) } : {},
        limit: 50,
      })
      return rows.length ? rows.map((r) => `#${r.id} [${r.scope}] ${r.text}`).join('\n') : '(none)'
    },
  })), 'orange: memory tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'user_tag',
    description: `Set or clear a tag on a person (tags: ${USER_TAGS.join(', ')} — dev = a developer, technical language is fine), `
      + 'and optionally replace the short note about them. user is the platform user id (im_read / im_history report senderId).',
    parameters: {
      user: { type: 'string', required: true },
      tag: { type: 'string', enum: [...USER_TAGS] },
      on: { type: 'boolean' },
      note: { type: 'string', description: 'Replace the note; "" clears it.' },
    },
    output: TEXT,
    async execute(args, exec) {
      caller(im, exec)
      const user = String(args.user).split('|').pop() ?? String(args.user)
      let row = store.user(user)
      if (args.tag !== undefined) row = await store.setUserTag(user, args.tag, args.on !== false)
      if (args.note !== undefined) row = await store.setUserNote(user, args.note)
      return row ? `${row.name ?? row.id}: tags [${row.tags.join(', ')}]${row.note ? ` note: ${row.note}` : ''}` : 'nothing changed'
    },
  })), 'orange: user_tag tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_repos',
    description: "The owner's projects relevant here, with every repository each lives in (main repo plus sibling repos) and the "
      + 'path to read or patch it. Call it before working on a report that may not belong to the main repo.',
    parameters: { query: { type: 'string', description: 'Project name, alias or repo to filter; omit for all.' } },
    output: TEXT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = caller(im, exec)
      const chat = homeChat(record)
      const root = deps.workspaceRoot(chat)
      const q = String(args.query ?? '').trim().toLowerCase()
      const all = projectsFor(deps.settings(), chat)
      const hit = q ? all.filter((p) => projectTerms(p).some((t) => t.toLowerCase().includes(q))) : all
      if (!hit.length) return q ? `(no project matches "${args.query}")` : '(no projects configured)'
      return hit.map((p) => [
        `${p.name} — ${p.note || p.repo}`,
        `  主仓库 ${p.repo} → ${root}/${p.repo.split('/').pop()}`,
        ...(p.subs ?? []).map((s) => `  子仓库 ${s.repo} → ${root}/${s.repo}${s.note ? `（${s.note}）` : ''}`),
      ].join('\n')).join('\n')
    },
  })), 'orange: project_repos tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_link',
    description: 'Task workers: record a PR or issue you opened (or took over) for this task. New GitHub comments and reviews on it '
      + 'are then handed to you automatically.',
    parameters: {
      url: { type: 'string', description: 'The PR/issue URL; or give repo + number.' },
      repo: { type: 'string', description: 'owner/name' },
      number: { type: 'integer' },
    },
    output: TEXT,
    async execute(args, exec) {
      const record = caller(im, exec)
      const task = deps.tasks()?.of(record.sessionId as never)
      if (task === undefined) return 'only a task worker can link a PR or issue'
      const parsed = /github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)/.exec(String(args.url ?? ''))
      const repo = parsed?.[1] ?? args.repo
      const number = parsed?.[3] ?? (args.number === undefined ? undefined : String(args.number))
      if (!repo || !number) return 'give a GitHub PR/issue url, or repo and number'
      const kind = parsed?.[2] === 'issues' ? 'issue' : 'pr'
      await store.link({ repo, number, kind, task: task.id, session: record.sessionId })
      return `linked ${repo}#${number} (${kind}) to task #${task.id}`
    },
  })), 'orange: task_link tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_tier',
    description: 'Task workers: switch the model your next steps run on. quality for writing/fixing code and PRs, vision when the '
      + 'task needs to look at images, fast for research and quick answers.',
    parameters: { tier: { type: 'string', enum: ['fast', 'quality', 'vision'], required: true } },
    output: TEXT,
    async execute(args, exec) {
      const record = caller(im, exec)
      if (roleOf(record) !== 'worker') return 'only a task worker switches tiers'
      const route = deps.config.taskModels[args.tier as 'fast' | 'quality' | 'vision']
      if (route === undefined) return `tier ${args.tier} is not configured; staying on the current model`
      const agent = exec.agent as unknown as { model?: { select(selection: { provider: string; model: string }): void } } | undefined
      if (agent?.model?.select === undefined) return 'this session cannot switch models'
      agent.model.select({ provider: route.provider, model: route.model })
      return `next steps run on ${route.provider}/${route.model} (${args.tier})`
    },
  })), 'orange: task_tier tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orange_chat',
    description: "Admins only (the message you answer must come from an admin): read or change this chat's profile — extra persona "
      + 'text for the chat, the workspace directory its workers use, and which projects belong to it. Wake/reply modes are configure_chat.',
    parameters: {
      prompt: { type: 'string', description: 'Extra persona text for this chat; "" clears it.' },
      workspace: { type: 'string', description: 'Workspace directory of this chat; "" clears it.' },
      projects: { type: 'array', items: { type: 'string' }, description: 'Project names of this chat; [] = all.' },
      name: { type: 'string', description: 'Display name for the panel.' },
    },
    output: TEXT,
    async execute(args, exec) {
      const record = caller(im, exec)
      const chat = homeChat(record)
      if (chat === undefined) return 'this session serves no chat'
      const settings = deps.settings()
      const current = profileOf(settings.chats, chat) ?? {}
      const changing = args.prompt !== undefined || args.workspace !== undefined || args.projects !== undefined || args.name !== undefined
      if (!changing) return JSON.stringify(current)
      if (!triggeredByAdmin(im, record, settings.admins)) return 'only an admin can change chat settings'
      const next = { ...current }
      const set = (key: 'prompt' | 'workspace' | 'name', value: string | undefined) => {
        if (value === undefined) return
        if (value.trim()) next[key] = value.trim()
        else delete next[key]
      }
      set('prompt', args.prompt)
      set('workspace', args.workspace)
      set('name', args.name)
      if (args.projects !== undefined) next.projects = args.projects
      const saved = store.settings()
      await store.saveSettings({ chats: { ...saved?.chats, [chat]: next } })
      return JSON.stringify(next)
    },
  })), 'orange: orange_chat tool')
}
