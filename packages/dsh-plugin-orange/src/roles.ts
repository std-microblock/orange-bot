/**
 * Who a hosted session is, as far as the bot's persona is concerned, and the effective settings (config seeds with
 * the panel's overrides on top).
 *
 * The roles come from the record dsh-im keeps for every hosted session, never from deep imports of the plugins that
 * created them: dispatch routers have `dispatch:` keys, task workers are owned by `session-tasks`, the voice session
 * by `orange-voice`. A subagent of any of them resolves to the same record (`ctx.im.sessions.of` walks the parent
 * chain).
 *
 * @module dsh-plugin-orange/roles
 */
import type { AssistTopic, ChatProfile, Config, OwnProject } from './config.ts'
import type { SettingsRecord } from './store.ts'

export type OrangeRole = 'router' | 'worker' | 'voice' | 'other'

/** The fields of a hosted session record this plugin reads (`ImSessionRecord`). */
export interface HostedLike {
  key: string
  owner: string
  sessionId: string
  bindings: readonly { chat: string; writable: boolean; home?: boolean }[]
  parent?: string
}

export const VOICE_OWNER = 'orange-voice'
export const TASKS_OWNER = 'session-tasks'

export function roleOf(record: HostedLike): OrangeRole {
  if (record.key.startsWith('dispatch:') || record.owner === 'dispatch') return 'router'
  if (record.owner === TASKS_OWNER) return 'worker'
  if (record.owner === VOICE_OWNER) return 'voice'
  return 'other'
}

/** The chat a session serves: its home binding, else its first one. */
export function homeChat(record: HostedLike): string | undefined {
  return record.bindings.find((binding) => binding.home)?.chat ?? record.bindings[0]?.chat
}

/** Bare platform chat id of a chat key (`qq:123|group:abc` → `group:abc`). */
export function chatId(chat: string): string {
  const at = chat.indexOf('|')
  return at < 0 ? chat : chat.slice(at + 1)
}

/** Whether a chat is a one-to-one chat (QQ `user:`, Lark `p2p`/`ou_`). */
export function isDirectChat(chat: string): boolean {
  const id = chatId(chat)
  return id.startsWith('user:') || id.startsWith('private:') || id.startsWith('ou_')
}

/** Whether a platform user is one of the configured admins (bare id, or `bot|id` pinned to one bot). */
export function isAdmin(admins: readonly string[], user: string | undefined, bot?: string): boolean {
  if (!user) return false
  return admins.some((entry) => entry === user || (bot !== undefined && entry === `${bot}|${user}`))
}

export interface Effective {
  admins: string[]
  owner: { name: string; github?: string; note?: string }
  persona: { chat: string; task: string; voice: string }
  projects: OwnProject[]
  assistTopics: AssistTopic[]
  chats: Record<string, ChatProfile>
}

/** Config seeds with the panel's saved settings on top (field by field). */
export function effective(config: Config, saved: SettingsRecord | undefined): Effective {
  const owner = { ...config.owner, ...saved?.owner }
  return {
    admins: config.admins,
    owner: { name: owner.name || '主人', ...owner.github ? { github: owner.github } : {}, ...owner.note ? { note: owner.note } : {} },
    persona: {
      chat: saved?.persona?.chat ?? config.persona.chat,
      task: saved?.persona?.task ?? config.persona.task,
      voice: saved?.persona?.voice ?? config.persona.voice,
    },
    projects: saved?.projects ?? config.projects,
    assistTopics: saved?.assistTopics ?? config.assistTopics,
    chats: { ...config.chats, ...saved?.chats },
  }
}

/** A chat's profile: exact key first, then the bare platform chat id. */
export function profileOf(chats: Record<string, ChatProfile>, chat: string | undefined): ChatProfile | undefined {
  if (chat === undefined) return undefined
  return chats[chat] ?? chats[chatId(chat)]
}

/** The projects that belong in one chat (all of them unless the chat's profile narrows it). */
export function projectsFor(settings: Effective, chat: string | undefined): OwnProject[] {
  const names = profileOf(settings.chats, chat)?.projects
  const list = names?.length ? settings.projects.filter((p) => names.includes(p.name)) : settings.projects
  // A private project is only ever listed where it may be discussed.
  return list.filter((project) => !project.private || privateAllowed(project, chat, settings.admins))
}

/** Whether a private project may be named in a chat: one of its chats, or an admin's direct chat. */
export function privateAllowed(project: OwnProject, chat: string | undefined, admins: readonly string[]): boolean {
  if (!project.private) return true
  if (chat === undefined) return false
  const id = chatId(chat)
  if ((project.chats ?? []).some((entry) => entry === chat || entry === id)) return true
  if (isDirectChat(chat)) {
    const user = id.replace(/^(user|private):/, '')
    return isAdmin(admins, user, chat.slice(0, chat.indexOf('|')))
  }
  return false
}
