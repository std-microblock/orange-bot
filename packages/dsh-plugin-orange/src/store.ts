/**
 * The bot's own durable state, on top of any key-value tables (the `orange` storage domain in production, `Map`s in
 * the tests): long-term memory, what it knows about people, the panel's settings, token usage, the PRs/issues a task
 * worker linked, and small bookkeeping values.
 *
 * Everything here is read synchronously from the table's in-memory index and written asynchronously, so prompt
 * assembly (which has to be synchronous) can read memory and settings directly.
 *
 * @module dsh-plugin-orange/store
 */
import type { AssistTopic, ChatProfile, OwnProject } from './config.ts'

/** The part of a storage-domain table this module uses. */
export interface Table<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** One long-term fact. */
export interface MemoryRecord {
  id: number
  /** `global`, `chat:<chat key>`, `user:<platform user id>`, `project:<name>`. */
  scope: string
  text: string
  at: number
  /** Chat the fact was written from, for the panel. */
  from?: string
}

/** One person the bot has seen. */
export interface UserRecord {
  /** Platform user id. */
  id: string
  name?: string
  /** Fixed tag set: `dev` = a developer (technical language is fine). */
  tags: string[]
  note?: string
  /** Last chat the person was seen in. */
  chat?: string
  updatedAt: number
}

/** What the panel saved; every present field overrides the config seed. */
export interface SettingsRecord {
  persona?: { chat?: string; task?: string; voice?: string }
  owner?: { name?: string; github?: string; note?: string }
  projects?: OwnProject[]
  assistTopics?: AssistTopic[]
  chats?: Record<string, ChatProfile>
  updatedAt: number
}

/** Token usage of one day, one session kind, one model. */
export interface UsageRecord {
  day: string
  kind: string
  model: string
  calls: number
  input: number
  cached: number
  output: number
}

/** A PR or issue a task worker linked to its task (`task_link`), followed by the GitHub poller. */
export interface TaskLinkRecord {
  repo: string
  number: string
  kind: 'pr' | 'issue'
  task: number
  /** Worker session id at link time. */
  session: string
  at: number
  /** ISO time up to which feedback was handed over. */
  seen?: string
}

export interface OrangeTables {
  memory: Table<MemoryRecord>
  users: Table<UserRecord>
  settings: Table<SettingsRecord>
  usage: Table<UsageRecord>
  links: Table<TaskLinkRecord>
  state: Table<{ value: string }>
}

export const USER_TAGS = ['dev'] as const

/** Memory scopes a reader sees: global, its own chat, people, projects. Other chats' facts stay in their chat. */
export function visibleScope(scope: string, chat: string | undefined, all: boolean): boolean {
  if (all) return true
  if (scope === 'global' || scope.startsWith('user:') || scope.startsWith('project:')) return true
  return chat !== undefined && scope === `chat:${chat}`
}

/** Normalize a scope the model wrote (`group:` was the v1 spelling of `chat:`). */
export function normalizeScope(scope: string | undefined, chat: string | undefined): string {
  const raw = String(scope ?? '').trim()
  if (raw === '' || raw === 'chat' || raw === 'group' || raw === 'here') return chat === undefined ? 'global' : `chat:${chat}`
  if (raw.startsWith('group:')) return `chat:${raw.slice(6)}`
  if (/^(global|chat:|user:|project:)/.test(raw)) return raw
  return `project:${raw}`
}

export class OrangeStore {
  private nextMemory = 1

  constructor(readonly tables: OrangeTables, private readonly now: () => number = Date.now) {
    for (const [, row] of tables.memory.entries()) this.nextMemory = Math.max(this.nextMemory, row.id + 1)
  }

  // ------------------------------------------------------------------------------------------------- memory
  async addMemory(scope: string, text: string, from?: string): Promise<MemoryRecord> {
    const clean = text.trim()
    if (!clean) throw new Error('memory text is empty')
    for (const [, row] of this.tables.memory.entries()) {
      if (row.scope === scope && row.text === clean) return row
    }
    const row: MemoryRecord = { id: this.nextMemory++, scope, text: clean.slice(0, 2000), at: this.now(), ...from ? { from } : {} }
    await this.tables.memory.put(String(row.id), row)
    return row
  }

  memory(id: number): MemoryRecord | undefined { return this.tables.memory.get(String(id)) }

  async deleteMemory(id: number): Promise<boolean> { return this.tables.memory.delete(String(id)) }

  async updateMemory(id: number, patch: { scope?: string; text?: string }): Promise<MemoryRecord | undefined> {
    const row = this.memory(id)
    if (row === undefined) return undefined
    const next = { ...row, ...patch.scope ? { scope: patch.scope } : {}, ...patch.text ? { text: patch.text.trim() } : {} }
    await this.tables.memory.put(String(id), next)
    return next
  }

  /**
   * Facts visible from one chat, newest first, optionally matching a query (every whitespace-separated term must
   * appear in the text or the scope).
   */
  memories(filter: { chat?: string; all?: boolean; query?: string; scope?: string; limit?: number } = {}): MemoryRecord[] {
    const terms = String(filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const rows: MemoryRecord[] = []
    for (const [, row] of this.tables.memory.entries()) {
      if (!visibleScope(row.scope, filter.chat, filter.all === true)) continue
      if (filter.scope !== undefined && row.scope !== filter.scope) continue
      const hay = `${row.scope} ${row.text}`.toLowerCase()
      if (terms.some((term) => !hay.includes(term))) continue
      rows.push(row)
    }
    rows.sort((a, b) => b.at - a.at || b.id - a.id)
    return rows.slice(0, filter.limit ?? 50)
  }

  /** What the prompt shows: the chat's own facts first, then global ones. */
  promptFacts(chat: string | undefined, limit: number): MemoryRecord[] {
    if (limit <= 0) return []
    const own = chat === undefined ? [] : this.memories({ chat, scope: `chat:${chat}`, limit })
    const global = this.memories({ scope: 'global', limit })
    return [...own, ...global].slice(0, limit)
  }

  // -------------------------------------------------------------------------------------------------- users
  user(id: string): UserRecord | undefined { return this.tables.users.get(id) }

  users(query?: string): UserRecord[] {
    const q = String(query ?? '').toLowerCase()
    const rows = [...this.tables.users.entries()].map(([, row]) => row)
      .filter((row) => !q || row.id.toLowerCase().includes(q) || (row.name ?? '').toLowerCase().includes(q) || (row.note ?? '').toLowerCase().includes(q))
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }

  /** Remember a sender's display name (written only when it changed). */
  async seen(id: string, name: string | undefined, chat: string): Promise<void> {
    const row = this.user(id)
    if (row !== undefined && (name === undefined || row.name === name)) return
    await this.tables.users.put(id, { tags: [], ...row, id, ...name ? { name } : {}, chat, updatedAt: this.now() })
  }

  async setUserTag(id: string, tag: string, on: boolean): Promise<UserRecord> {
    if (!(USER_TAGS as readonly string[]).includes(tag)) throw new Error(`unknown tag ${tag}; the tags are ${USER_TAGS.join(', ')}`)
    const row = this.user(id) ?? { id, tags: [], updatedAt: this.now() }
    const tags = new Set(row.tags)
    if (on) tags.add(tag)
    else tags.delete(tag)
    const next = { ...row, tags: [...tags], updatedAt: this.now() }
    await this.tables.users.put(id, next)
    return next
  }

  async setUserNote(id: string, note: string): Promise<UserRecord> {
    const row = this.user(id) ?? { id, tags: [], updatedAt: this.now() }
    const next: UserRecord = { ...row, updatedAt: this.now() }
    if (note.trim()) next.note = note.trim()
    else delete next.note
    await this.tables.users.put(id, next)
    return next
  }

  // ----------------------------------------------------------------------------------------------- settings
  settings(): SettingsRecord | undefined { return this.tables.settings.get('current') }

  async saveSettings(patch: Omit<SettingsRecord, 'updatedAt'>): Promise<SettingsRecord> {
    const next: SettingsRecord = { ...this.settings(), ...patch, updatedAt: this.now() }
    await this.tables.settings.put('current', next)
    return next
  }

  // -------------------------------------------------------------------------------------------------- usage
  async addUsage(entry: { kind: string; model: string; input: number; cached: number; output: number; at?: number }): Promise<void> {
    const day = new Date(entry.at ?? this.now()).toISOString().slice(0, 10)
    const key = `${day}|${entry.kind}|${entry.model}`
    const row = this.tables.usage.get(key) ?? { day, kind: entry.kind, model: entry.model, calls: 0, input: 0, cached: 0, output: 0 }
    await this.tables.usage.put(key, {
      ...row,
      calls: row.calls + 1,
      input: row.input + entry.input,
      cached: row.cached + entry.cached,
      output: row.output + entry.output,
    })
  }

  usage(sinceDay?: string): UsageRecord[] {
    return [...this.tables.usage.entries()].map(([, row]) => row)
      .filter((row) => sinceDay === undefined || row.day >= sinceDay)
      .sort((a, b) => b.day.localeCompare(a.day) || a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model))
  }

  // -------------------------------------------------------------------------------------------------- links
  async link(entry: Omit<TaskLinkRecord, 'at'>): Promise<TaskLinkRecord> {
    const row: TaskLinkRecord = { ...entry, at: this.now() }
    await this.tables.links.put(`${entry.repo}#${entry.number}`, row)
    return row
  }

  linkOf(repo: string, number: string): TaskLinkRecord | undefined { return this.tables.links.get(`${repo}#${number}`) }

  links(task?: number): TaskLinkRecord[] {
    return [...this.tables.links.entries()].map(([, row]) => row).filter((row) => task === undefined || row.task === task)
  }

  async markSeen(repo: string, number: string, seen: string): Promise<void> {
    const row = this.linkOf(repo, number)
    if (row !== undefined) await this.tables.links.put(`${repo}#${number}`, { ...row, seen })
  }

  // -------------------------------------------------------------------------------------------------- state
  state(key: string): string | undefined { return this.tables.state.get(key)?.value }

  async setState(key: string, value: string): Promise<void> { await this.tables.state.put(key, { value }) }
}

/** In-memory tables, for tests and dry runs. Keys go through {@link pathSafeTable}, as in production. */
export function memoryTables(): OrangeTables {
  const table = <V>(): Table<V> => {
    const map = new Map<string, V>()
    return pathSafeTable({
      get: (key) => map.get(key),
      entries: () => map.entries(),
      put: async (key, value) => {
        if (!SAFE_KEY.test(key)) throw new Error(`per-record key '${key}' is not path-safe`)
        map.set(key, value)
      },
      delete: async (key) => map.delete(key),
    })
  }
  return { memory: table(), users: table(), settings: table(), usage: table(), links: table(), state: table() }
}

/** What a `per-record` storage-domain key may look like (it becomes a file name). */
export const SAFE_KEY = /^[a-zA-Z0-9_-]+$/

/** A key as stored: itself when path-safe, else `k_` + base64url (a safe key that itself starts with `k_` is encoded too). */
export function encodeKey(key: string): string {
  return SAFE_KEY.test(key) && !key.startsWith('k_') ? key : `k_${Buffer.from(key, 'utf8').toString('base64url')}`
}

export function decodeKey(stored: string): string {
  return stored.startsWith('k_') ? Buffer.from(stored.slice(2), 'base64url').toString('utf8') : stored
}

/** Wrap a table so arbitrary keys (`2026-11-20|router|model`, `owner/repo#7`, openids) map to path-safe ones. */
export function pathSafeTable<V>(table: Table<V>): Table<V> {
  return {
    get: (key) => table.get(encodeKey(key)),
    *entries() { for (const [key, value] of table.entries()) yield [decodeKey(key), value] },
    put: (key, value) => table.put(encodeKey(key), value),
    delete: (key) => table.delete(encodeKey(key)),
  }
}
