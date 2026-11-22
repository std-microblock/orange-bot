#!/usr/bin/env node
// Export what is worth keeping from the v1 database (~/.orange/orange.db) for dsh-plugin-orange's one-time import.
//
//   node scripts/migrate-from-v1.mjs --qq-bot qq:<AppID> [--db ~/.orange/orange.db] [--stickers ~/.orange/stickers]
//                                    [--out ./migration-out] [--write]
//
// Dry run by default: reads the database and prints what would be exported. With --write it creates <out>/export.json
// and copies the sticker files to <out>/stickers/; point the `orange` row's `importV1` (ORANGE_IMPORT_V1) at <out>
// and restart — the plugin imports it once (memory and user tags into the `orange` storage domain, stickers into
// dsh-im-stickers, projects / assist topics / persona overrides / per-group notes and workspaces into its settings).
//
// What is mapped:
//   memory      global, project:<name> as they are; group:qq:<id> → chat:<qq bot>|group:<id> (or |user:<id> for a
//               direct chat); user:qq:<id> → user:<id>. Userbot (cg:) facts are dropped — that platform is gone.
//   users       qq:<id> rows with tags or a note → id <id>; cg: rows dropped.
//   stickers    every row whose file exists in the sticker directory (uploads and bridge imports alike), with its
//               description, type tags, weight and enabled switch.
//   settings    ownProjects → projects, assistTopics, prompts.chat/task → persona, groups[*].note/workspace → chats.
// Not mapped: messages, responses, classifications, events, media, tasks, llm_calls (v2 keeps its own usage).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)
const expand = (path) => resolve(path.replace(/^~(?=$|[/\\])/, homedir()))

const db = expand(option('db', '~/.orange/orange.db'))
const stickerDir = expand(option('stickers', join(db, '..', 'stickers')))
const out = expand(option('out', './migration-out'))
const bot = option('qq-bot')
const write = flag('write')
if (!bot || !/^qq:\S+$/.test(bot)) {
  console.error('usage: node scripts/migrate-from-v1.mjs --qq-bot qq:<AppID> [--db …] [--stickers …] [--out …] [--write]')
  process.exit(2)
}
if (!existsSync(db)) {
  console.error(`no database at ${db}`)
  process.exit(1)
}

const sql = new DatabaseSync(db, { readOnly: true })
const tables = new Set(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name))
const all = (query) => sql.prepare(query).all()
const json = (text, fallback) => { try { return text ? JSON.parse(text) : fallback } catch { return fallback } }

const direct = new Map(tables.has('conversations') ? all('SELECT key, direct FROM conversations').map((r) => [r.key, !!r.direct]) : [])
/** A v1 conversation key (`qq:<id>`) as a v2 chat key, or undefined for the userbot. */
const chatKey = (conv) => {
  if (!conv.startsWith('qq:')) return undefined
  const id = conv.slice(3)
  return `${bot}|${direct.get(conv) ? 'user' : 'group'}:${id}`
}

const dropped = { memory: 0, users: 0, stickers: 0 }

// ---- memory
const memory = []
for (const row of tables.has('memory') ? all('SELECT scope, text, ts FROM memory ORDER BY id') : []) {
  const scope = String(row.scope ?? 'global')
  let next
  if (scope === 'global' || scope.startsWith('project:')) next = scope
  else if (scope.startsWith('group:')) { const chat = chatKey(scope.slice(6)); next = chat && `chat:${chat}` }
  else if (scope.startsWith('user:qq:')) next = `user:${scope.slice(8)}`
  else if (scope.startsWith('user:') && !scope.startsWith('user:cg:')) next = scope
  if (!next || !String(row.text ?? '').trim()) { dropped.memory += 1; continue }
  memory.push({ scope: next, text: String(row.text).trim(), ...row.ts ? { at: Number(row.ts) } : {} })
}

// ---- users
const users = []
for (const row of tables.has('users') ? all('SELECT key, name, tags, note FROM users') : []) {
  const key = String(row.key ?? '')
  const tags = json(row.tags, [])
  const note = String(row.note ?? '').trim()
  if (!key.startsWith('qq:') || (!tags.length && !note)) { if (!key.startsWith('qq:')) dropped.users += 1; continue }
  users.push({ id: key.slice(3), ...row.name ? { name: String(row.name) } : {}, ...tags.length ? { tags } : {}, ...note ? { note } : {} })
}

// ---- stickers
const stickers = []
for (const row of tables.has('stickers') ? all('SELECT file, title, desc_text, tags, weight, enabled FROM stickers ORDER BY id') : []) {
  const file = basename(String(row.file ?? ''))
  if (!file || !existsSync(join(stickerDir, file))) { dropped.stickers += 1; continue }
  stickers.push({
    file,
    ...row.title ? { title: String(row.title) } : {},
    ...row.desc_text ? { desc: String(row.desc_text) } : {},
    tags: json(row.tags, []),
    weight: Number(row.weight ?? 50),
    enabled: !!row.enabled,
  })
}

// ---- settings
const kv = tables.has('kv') ? sql.prepare("SELECT value FROM kv WHERE key = 'settings'").get() : undefined
const v1 = json(kv?.value, {})
const settings = {}
if (Array.isArray(v1.ownProjects)) settings.projects = v1.ownProjects
if (Array.isArray(v1.assistTopics)) settings.assistTopics = v1.assistTopics
const persona = {}
if (v1.prompts?.chat) persona.chat = v1.prompts.chat
if (v1.prompts?.task) persona.task = v1.prompts.task
if (Object.keys(persona).length) settings.persona = persona
const chats = {}
for (const [conv, group] of Object.entries(v1.groups ?? {})) {
  const chat = chatKey(conv)
  if (!chat || !group || typeof group !== 'object') continue
  const profile = {}
  if (group.note) profile.prompt = String(group.note)
  if (group.workspace) profile.workspace = String(group.workspace)
  if (Object.keys(profile).length) chats[chat] = profile
}
if (Object.keys(chats).length) settings.chats = chats

const exported = { version: 1, createdAt: new Date().toISOString(), source: { bot }, memory, users, stickers, settings }
console.log(`${write ? 'exporting' : 'dry run'}: ${db}`)
console.log(`  memory   ${memory.length} (dropped ${dropped.memory}: userbot or empty)`)
console.log(`  users    ${users.length} with tags or notes (dropped ${dropped.users} userbot rows)`)
console.log(`  stickers ${stickers.length} (skipped ${dropped.stickers}: file missing in ${stickerDir})`)
console.log(`  settings ${Object.keys(settings).join(', ') || '(none)'}${settings.chats ? ` — ${Object.keys(settings.chats).length} chat profiles` : ''}`)
if (!write) {
  console.log('nothing written; add --write to create the export')
  process.exit(0)
}
mkdirSync(join(out, 'stickers'), { recursive: true })
for (const sticker of stickers) copyFileSync(join(stickerDir, sticker.file), join(out, 'stickers', sticker.file))
writeFileSync(join(out, 'export.json'), `${JSON.stringify(exported, null, 2)}\n`)
console.log(`written: ${join(out, 'export.json')} and ${stickers.length} sticker files; set ORANGE_IMPORT_V1=${out} and restart`)
