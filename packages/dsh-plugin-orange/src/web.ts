/**
 * Web panel API under /orange-api (registered on ctx.webServer, guarded by the
 * dsh GUI's own cookie/host checks via ctx.connection.requestRejection), plus an
 * SSE stream of live bot events.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { OrangeBot } from './bot.ts'
import { sniffImage as sniff } from './bot.ts'
import { humanText, plainText } from './markup.ts'
import { CHAT_PERSONA, TASK_PERSONA } from './prompts.ts'
import { PRICE } from './store.ts'

const PREFIX = '/orange-api'

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

/** Uploaded stickers arrive as data URLs, so the JSON body is the size limit / 1.37. */
const UPLOAD_BODY_LIMIT = 96 * 1024 * 1024
const UPLOAD_FILE_LIMIT = 24 * 1024 * 1024

export function registerWebApi(ctx: any, getBot: () => OrangeBot | undefined): void {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const connection = ctx.get('connection')
    const rejection = connection?.requestRejection({ headers: req.headers })
    if (rejection) return json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    const bot = getBot()
    if (!bot) return json(res, 503, { error: 'bot not running' })
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname.slice(PREFIX.length)
    const q = url.searchParams
    try {
      if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
        res.write(`data: ${JSON.stringify({ type: 'status', status: bot.status })}\n\n`)
        const listener = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`)
        bot.listeners.add(listener)
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        req.on('close', () => { bot.listeners.delete(listener); clearInterval(ping) })
        return
      }
      if (req.method === 'GET' && path === '/overview') {
        const settings = bot.store.settings()
        // Titles and avatars are resolved, not stored: an official-bot group has
        // neither of its own, and a stored copy would survive a pairing correction.
        const conversations = bot.store.conversations().map((c) => ({ ...c, title: bot.store.convTitle(c.key), avatar: bot.store.convAvatar(c.key), settings: bot.store.group(c.key) }))
        // groups configured but not seen yet
        for (const key of Object.keys(settings.groups)) {
          if (!conversations.some((c) => c.key === key)) conversations.push({ key, platform: key.slice(0, 2) as any, channelId: key.slice(3), title: bot.store.convTitle(key), avatar: bot.store.convAvatar(key), direct: false, lastTs: 0, count: 0, settings: bot.store.group(key) })
        }
        // The panel shows prompts as the *effective* text: the stored '' would be
        // an empty textarea, and the built-in it stands for is what you tune from.
        const withDefaults = { ...settings, prompts: { chat: settings.prompts.chat || CHAT_PERSONA, task: settings.prompts.task || TASK_PERSONA } }
        return json(res, 200, { status: bot.status, conversations, settings: withDefaults, price: PRICE })
      }
      if (req.method === 'GET' && path === '/messages') {
        const conv = q.get('conv') ?? ''
        const before = q.get('before') ? Number(q.get('before')) : undefined
        const around = q.get('around') ? Number(q.get('around')) : undefined
        const limit = Math.min(300, Number(q.get('limit')) || 100)
        const messages = around
          ? [...bot.store.recent(conv, Math.floor(limit / 2), around + 1), ...bot.store.after(conv, around, Math.ceil(limit / 2))]
          : bot.store.recent(conv, limit, before)
        const since = messages[0]?.ts ?? 0
        const until = around ? (messages.at(-1)?.ts ?? Date.now()) + 1 : Date.now() + 1
        const responses = bot.store.db.prepare('SELECT * FROM responses WHERE conv = ? AND ts BETWEEN ? AND ? ORDER BY id').all(conv, since - 60_000, until)
        const classifications = bot.store.db.prepare('SELECT * FROM classifications WHERE conv = ? AND ts BETWEEN ? AND ? ORDER BY id').all(conv, since - 60_000, until)
        const session = bot.store.get<any>(`session:${conv}`, undefined)
        const platform = conv.slice(0, 2)
        const avatars: Record<string, string> = {}
        const ids = [...new Set(messages.map((m) => m.senderId))]
        if (ids.length) {
          for (const r of bot.store.db.prepare(`SELECT key, avatar FROM users WHERE key IN (${ids.map(() => '?').join(',')}) AND avatar IS NOT NULL`).all(...ids.map((id) => `${platform}:${id}`)) as any[]) avatars[r.key.slice(3)] = r.avatar
        }
        // Who is who: the panel badges a sender the same way the agent's prompt does.
        const roles: Record<string, string> = {}
        for (const id of ids) {
          const rank = bot.rank(conv, id)
          if (rank !== 'member') roles[id] = rank
        }
        const groupRoles = bot.store.memberRoles(conv, true).map((r) => ({ id: r.userId, role: r.role, name: bot.display(`${platform}:${r.userId}`) }))
        return json(res, 200, { messages, responses, classifications, avatars, roles, groupRoles, session: session?.sessionId ?? null, hasMore: messages.length >= Math.floor(limit / (around ? 2 : 1)) })
      }
      if (req.method === 'GET' && path === '/previews') {
        const rows = bot.store.db.prepare(`SELECT m.conv, m.sender_name, m.from_bot, m.text FROM messages m
          JOIN (SELECT conv, MAX(seq) seq FROM messages GROUP BY conv) last ON last.seq = m.seq`).all() as any[]
        // this line is read by a person, so it goes through humanText: a conversation whose last
        // message is a merged forward used to preview as `<forward id="1" title="群聊的聊天记录" …`
        return json(res, 200, Object.fromEntries(rows.map((r) => [r.conv, `${r.from_bot ? '橘波特' : r.sender_name}: ${humanText(r.text, 60)}`])))
      }
      if (req.method === 'GET' && path === '/responses') {
        const conv = q.get('conv') || undefined
        const trigger = q.get('trigger') || undefined
        // dry run is its own axis (any trigger can be dry), so the panel filters
        // it separately: `dry=1` keeps only what was never actually delivered.
        const dry = q.get('dry')
        const where: string[] = []
        const args: any[] = []
        if (conv) { where.push('r.conv = ?'); args.push(conv) }
        if (trigger) { where.push('r.trigger = ?'); args.push(trigger) }
        if (dry === '1' || dry === '0') { where.push('r.dry_run = ?'); args.push(Number(dry)) }
        const rows = bot.store.db.prepare(`SELECT r.* FROM responses r ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 300`).all(...args) as any[]
        // the message just before each response is the most likely trigger
        for (const r of rows) {
          r.title = bot.store.convTitle(r.conv)
          r.trigger_message = bot.store.db.prepare('SELECT seq, sender_name, text, ts FROM messages WHERE conv = ? AND ts <= ? AND from_bot = 0 ORDER BY ts DESC LIMIT 1').get(r.conv, r.ts) ?? null
          // shown as context next to the response, so the same one-line treatment as a quote row
          if (r.trigger_message) r.trigger_message.text = humanText(r.trigger_message.text, 140)
          // ... and the wording that went out is shown to a person too: a reply written before the
          // fix still carries `<quote>…</quote>` inside it (see the README section on quote rows).
          // Line breaks stay: this is the record of what was sent, not a preview.
          r.text = plainText(r.text)
        }
        return json(res, 200, rows)
      }
      if (req.method === 'GET' && path === '/media') {
        // `id` is the attachment id a message prints as `[图片 #12]` (see media.ts); `seq`+`index`
        // (+`forward` for one inside a merged forward) is the old addressing, still there for the
        // records stored before attachments had ids.
        const id = Number(q.get('id') || 0)
        const forward = q.get('forward')
        let row = id ? bot.store.media(id) : undefined
        if (!row) {
          const m = bot.store.bySeq(Number(q.get('seq')))
          row = m ? await bot.legacyMedia(m, Number(q.get('index') || 1), forward ? String(forward) : undefined).catch(() => undefined) : undefined
        }
        if (!row) return json(res, 404, { error: 'no media' })
        const found = await bot.mediaUrl(row).catch(() => undefined)
        if (!found || !('url' in found)) return json(res, 404, { error: found && 'error' in found ? found.error : 'no media' })
        const file = await bot.downloadMedia(found.url)
        res.writeHead(200, { 'Content-Type': sniff(file.data) ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' })
        res.end(Buffer.from(file.data))
        return
      }
      if (req.method === 'GET' && path === '/stats') {
        const hours = Number(q.get('hours')) || 24
        return json(res, 200, { hours, ...bot.store.stats(hours * 3600_000), day: bot.store.stats(86400_000).byKind, week: bot.store.stats(7 * 86400_000).byKind })
      }
      if (req.method === 'GET' && path === '/tasks') {
        const rows = bot.store.db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 200').all() as any[]
        for (const t of rows) t.conv_title = bot.store.convTitle(t.conv)
        return json(res, 200, rows)
      }
      if (req.method === 'GET' && path === '/memory') return json(res, 200, { memory: bot.store.memories(undefined, 300), users: bot.store.users(), events: bot.store.events(100) })
      if (req.method === 'POST' && path === '/group') {
        const body = await readBody(req)
        const next = bot.store.updateGroup(String(body.conv), body.patch ?? {})
        bot.broadcast({ type: 'settings' })
        return json(res, 200, next)
      }
      if (req.method === 'POST' && path === '/settings') {
        const body = await readBody(req)
        // The body carries the effective prompt text (see /overview): saving it
        // unchanged (or clearing the box) stores '' = follow the built-in, so
        // later code updates keep improving the persona until overridden.
        if (body.prompts) body.prompts = {
          chat: !String(body.prompts.chat ?? '').trim() || body.prompts.chat === CHAT_PERSONA ? '' : String(body.prompts.chat),
          task: !String(body.prompts.task ?? '').trim() || body.prompts.task === TASK_PERSONA ? '' : String(body.prompts.task),
        }
        bot.store.saveSettings({ ...bot.store.settings(), ...body })
        bot.broadcast({ type: 'settings' })
        return json(res, 200, bot.store.settings())
      }
      if (req.method === 'POST' && path === '/send') {
        const body = await readBody(req)
        const result = await bot.sendText(String(body.conv), String(body.text), { trigger: 'manual' })
        return json(res, 200, result)
      }
      if (req.method === 'POST' && path === '/wake') {
        const body = await readBody(req)
        await bot.wake(String(body.conv), 'admin', undefined, String(body.reason ?? 'manual'))
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && path === '/reset') {
        const body = await readBody(req)
        await bot.resetSession(String(body.conv))
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && path === '/memory/delete') {
        const body = await readBody(req)
        bot.store.deleteMemory(Number(body.id))
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && path === '/user-tag') {
        const body = await readBody(req)
        bot.store.setUserTag(String(body.user), String(body.tag), !!body.on)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && path === '/task/message') {
        const body = await readBody(req)
        return json(res, 200, { ok: await bot.messageTask(Number(body.id), String(body.text)) })
      }
      // ---- stickers --------------------------------------------------------
      if (req.method === 'GET' && path === '/stickers') {
        const tags = (q.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean)
        const enabled = q.get('enabled') === null ? undefined : q.get('enabled') === '1'
        const rows = bot.stickers.list({
          tags, enabled,
          untagged: q.get('untagged') === '1',
          query: q.get('query') ?? undefined,
          source: q.get('source') ?? undefined,
          order: q.get('order') ?? undefined,
          limit: Math.min(1000, Number(q.get('limit')) || 500),
        })
        return json(res, 200, {
          stickers: rows, types: bot.stickers.types(), tagCounts: bot.stickers.tagCounts(),
          stats: bot.stickers.stats(), job: bot.stickers.jobState() ?? null,
        })
      }
      if (req.method === 'GET' && path === '/sticker/file') {
        const row = bot.stickers.get(Number(q.get('id')))
        if (!row) return json(res, 404, { error: 'no such sticker' })
        const thumb = q.get('thumb') === '1' && !!row.thumb
        const file = await readFile(bot.stickers.filePath(row, thumb)).catch(() => undefined)
        if (!file) return json(res, 404, { error: 'file missing' })
        res.writeHead(200, { 'Content-Type': thumb ? 'image/png' : (row.mime || 'application/octet-stream'), 'Cache-Control': 'private, max-age=86400' })
        res.end(file)
        return
      }
      if (req.method === 'POST' && path === '/sticker/update') {
        const body = await readBody(req)
        const patch: any = {}
        if (body.desc !== undefined) patch.desc = String(body.desc).slice(0, 200)
        if (body.tags !== undefined) patch.tags = (Array.isArray(body.tags) ? body.tags : []).map(String).filter((t) => bot.stickers.types().some((x) => x.id === t))
        if (body.weight !== undefined) patch.weight = Number(body.weight)
        if (body.enabled !== undefined) patch.enabled = !!body.enabled
        if (body.title !== undefined) patch.title = String(body.title)
        const row = bot.stickers.update(Number(body.id), patch)
        if (!row) return json(res, 404, { error: 'no such sticker' })
        bot.broadcast({ type: 'sticker', id: row.id })
        return json(res, 200, row)
      }
      if (req.method === 'POST' && path === '/sticker/batch') {
        const body = await readBody(req)
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n: number) => Number.isFinite(n))
        if (!ids.length) return json(res, 400, { error: 'ids required' })
        const rows = bot.store.stickersByIds(ids)
        const known = new Set(bot.stickers.types().map((t) => t.id))
        const op = String(body.op ?? '')
        let affected = 0
        if (op === 'enable' || op === 'disable') {
          for (const row of rows) { bot.stickers.update(row.id, { enabled: op === 'enable' }); affected++ }
        } else if (op === 'tag-add' || op === 'tag-remove') {
          const tag = String(body.tag ?? '')
          if (!known.has(tag)) return json(res, 400, { error: `unknown sticker type ${tag}` })
          for (const row of rows) {
            const tags = op === 'tag-add'
              ? [...new Set([...row.tags, tag])]
              : row.tags.filter((t) => t !== tag)
            if (tags.length !== row.tags.length || op === 'tag-add') { bot.stickers.update(row.id, { tags }); affected++ }
          }
        } else if (op === 'weight-set' || op === 'weight-add') {
          const value = Number(body.value) || 0
          for (const row of rows) { bot.stickers.update(row.id, { weight: op === 'weight-set' ? value : row.weight + value }); affected++ }
        } else if (op === 'delete') {
          affected = await bot.stickers.remove(ids)
        } else if (op === 'classify') {
          const job = bot.stickers.beginClassify(ids, { force: body.force !== false })
          return json(res, 200, { affected: job.total, job })
        } else return json(res, 400, { error: `unknown op ${op}` })
        bot.broadcast({ type: 'sticker' })
        return json(res, 200, { affected })
      }
      if (req.method === 'GET' && path === '/stickers/remote') {
        const remote = await bot.stickers.remote({ refresh: q.get('refresh') === '1' })
        const imported = new Set(bot.stickers.list({ limit: 1000, enabled: undefined }).map((s) => s.key))
        return json(res, 200, {
          at: remote.at, cached: remote.cached,
          stickers: remote.stickers.map((s) => ({ ...s, key: `${s.providerId}|${s.stickerId}`, imported: imported.has(`${s.providerId}:${s.stickerId}`) })),
        })
      }
      if (req.method === 'POST' && path === '/stickers/import') {
        const body = await readBody(req)
        const job = bot.stickers.beginImport(Array.isArray(body.keys) ? body.keys.map(String) : [], { classify: body.classify !== false, refresh: !!body.refresh })
        return json(res, 200, { job })
      }
      if (req.method === 'GET' && path === '/stickers/job') return json(res, 200, { job: bot.stickers.jobState() ?? null })
      if (req.method === 'POST' && path === '/stickers/job/cancel') return json(res, 200, { cancelled: bot.stickers.cancel() })
      if (req.method === 'POST' && path === '/stickers/upload') {
        const body = await readBody(req, UPLOAD_BODY_LIMIT)
        const files: { name: string, data: Uint8Array }[] = []
        const skipped: string[] = []
        for (const item of Array.isArray(body.files) ? body.files : []) {
          const name = String(item?.name ?? 'sticker')
          const match = /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(String(item?.dataUrl ?? ''))
          if (!match) { skipped.push(`${name}（不是图片）`); continue }
          const data = Buffer.from(match[2], 'base64')
          if (!data.byteLength || data.byteLength > UPLOAD_FILE_LIMIT) { skipped.push(`${name}（${Math.round(data.byteLength / 1048576)}MB，超大）`); continue }
          files.push({ name, data })
        }
        if (!files.length) return json(res, 400, { error: `没有可导入的图片：${skipped.join('、') || '空的'}` })
        const result = await bot.stickers.addUploads(files)
        bot.broadcast({ type: 'sticker' })
        return json(res, 200, { ...result, skipped })
      }
      if (req.method === 'POST' && path === '/stickers/test-send') {
        const body = await readBody(req)
        const row = bot.stickers.get(Number(body.id))
        if (!row) return json(res, 404, { error: 'no such sticker' })
        const result = await bot.stickers.send(row, String(body.conv), { trigger: 'manual' })
        return json(res, 200, { ...result, desc: row.desc, tags: row.tags })
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 500, { error: (error as Error).message })
    }
  }
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: PREFIX, handler }), 'orange: web api')
  })
}
