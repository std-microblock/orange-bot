/**
 * SQLite persistence (node:sqlite, no native deps). Everything the bot observes
 * or does is recorded here so the Web panel and the agent tools read one truth.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type GroupSettings, type OwnProject, type RuntimeSettings } from './config.ts'
import { groupAvatar, pairText } from './pairing.ts'

export interface StoredMessage {
  seq: number
  conv: string
  id: string
  senderId: string
  senderName: string
  ts: number
  /** Compact model-facing rendering (text + <img/>, <forward/> ... tags). */
  text: string
  /** Platform elements / parts, JSON. */
  raw: string
  replyTo?: string
  self: boolean
  mentionsSelf: boolean
  /** true when the bot generated it (not the admin typing on the userbot account). */
  fromBot: boolean
}

export interface ConversationRow {
  avatar?: string
  key: string
  platform: 'qq' | 'cg'
  channelId: string
  title: string
  /** Where the title came from: 'qq' = official group API, 'cg' = userbot, 'dm' = peer name. */
  titleSrc?: string
  direct: boolean
  lastTs: number
  count: number
}

/**
 * One attachment (image/file) the bot can look at, addressed by a stable id the model reads
 * inline as `[图片 #12]` (see media.ts). `url` is a directly usable address, which only exists
 * for an attachment we received as data — inside a merged forward even a message's own url is
 * not enough: the platform's url carries an rkey that expires, so a forward attachment is
 * stored as `plan` (locator + path + position, or the official dump's sender/title) and its url
 * is asked for again when the agent actually looks at it (bot.ts resolveMedia).
 */
export interface MediaRow {
  id: number
  conv: string
  messageId: string
  /** message | quote | forward */
  source: string
  kind: string
  name?: string
  mime?: string
  size?: number
  width?: number
  height?: number
  url?: string
  /** JSON resolution plan for forward attachments. */
  plan?: string
  created: number
  updated: number
}

export interface ResponseRow {
  id?: number
  ts: number
  conv: string
  trigger: string
  triggerSeq?: number
  sessionId?: string
  text: string
  dryRun: boolean
  delivered: boolean
  error?: string
  context?: string
}

/**
 * One sticker/表情 in the pool the agent may send. A sticker imported from the
 * QQ bridge also carries the native reference that makes it go out as a real QQ
 * 表情 rather than a picture; an uploaded file only has bytes (see stickers.ts).
 */
export interface StickerRow {
  id: number
  /** Stable identity: `<provider>:<refId>` for imports, `upload:<sha1>` for files. */
  key: string
  source: 'bridge' | 'upload'
  provider: string
  refId: string
  pack: string
  title: string
  /** One-sentence description written by the import classifier; what the agent reads. */
  desc: string
  /** Type ids from settings.stickers.types. */
  tags: string[]
  /** 0-100; higher is picked more often. */
  weight: number
  enabled: boolean
  format: string
  mime: string
  width: number
  height: number
  size: number
  /** File name inside <dataDir>/stickers (original bytes). */
  file: string
  /** File name inside <dataDir>/stickers/thumbs (small preview), or ''. */
  thumb: string
  /** JSON of the native send reference (bridge imports only). */
  reference: string
  uses: number
  lastUsed: number
  created: number
  updated: number
  /** Last classification failure, for the panel. */
  error: string
}

export class Store {
  readonly db: DatabaseSync
  private settingsCache?: RuntimeSettings

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(join(dataDir, 'orange.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        conv TEXT NOT NULL, id TEXT NOT NULL,
        sender_id TEXT, sender_name TEXT, ts INTEGER,
        text TEXT, raw TEXT, reply_to TEXT,
        ntext TEXT DEFAULT '',
        self INTEGER DEFAULT 0, mentions_self INTEGER DEFAULT 0, from_bot INTEGER DEFAULT 0,
        UNIQUE(conv, id)
      );
      CREATE INDEX IF NOT EXISTS messages_conv_ts ON messages(conv, ts);
      CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id);
      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY, platform TEXT, channel_id TEXT, title TEXT, title_src TEXT, direct INTEGER,
        last_ts INTEGER, count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS users (
        key TEXT PRIMARY KEY, name TEXT, tags TEXT DEFAULT '[]', note TEXT DEFAULT '', updated INTEGER
      );
      CREATE TABLE IF NOT EXISTS member_roles (
        conv TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, source TEXT, updated INTEGER,
        PRIMARY KEY(conv, user_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, conv TEXT, text TEXT
      );
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, scope TEXT, text TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER, updated INTEGER,
        conv TEXT, title TEXT, kind TEXT, status TEXT, session_id TEXT,
        repo TEXT, issue TEXT, pr TEXT, note TEXT
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, model TEXT,
        input INTEGER, cached INTEGER, output INTEGER, cost REAL, conv TEXT, ref TEXT
      );
      CREATE INDEX IF NOT EXISTS llm_calls_ts ON llm_calls(ts);
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, conv TEXT, trigger TEXT, trigger_seq INTEGER,
        session_id TEXT, text TEXT, dry_run INTEGER, delivered INTEGER, error TEXT, context TEXT
      );
      CREATE INDEX IF NOT EXISTS responses_conv ON responses(conv, ts);
      CREATE TABLE IF NOT EXISTS classifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, conv TEXT, from_seq INTEGER, to_seq INTEGER,
        wake INTEGER, kind TEXT, reason TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_key TEXT UNIQUE, conv TEXT, message_id TEXT, source TEXT,
        kind TEXT, name TEXT, mime TEXT, size INTEGER, width INTEGER, height INTEGER,
        url TEXT, plan TEXT, created INTEGER, updated INTEGER
      );
    `)
    for (const sql of [
      'ALTER TABLE users ADD COLUMN avatar TEXT',
      'ALTER TABLE conversations ADD COLUMN avatar TEXT',
      'ALTER TABLE conversations ADD COLUMN title_src TEXT',
      'ALTER TABLE messages ADD COLUMN ntext TEXT',
    ]) { try { this.db.exec(sql) } catch {} }
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_ntext ON messages(ntext)')
    // Stickers arrived after the first installs, so the table is created here
    // rather than in the block above: an existing database must be migrated, not
    // recreated. `key` keeps a re-import from duplicating a 表情.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE, source TEXT, provider TEXT, ref_id TEXT, pack TEXT, title TEXT,
        desc_text TEXT DEFAULT '', tags TEXT DEFAULT '[]', weight INTEGER DEFAULT 50, enabled INTEGER DEFAULT 1,
        format TEXT, mime TEXT, width INTEGER, height INTEGER, size INTEGER,
        file TEXT, thumb TEXT, reference TEXT,
        uses INTEGER DEFAULT 0, last_used INTEGER, created INTEGER, updated INTEGER, error TEXT
      );
      CREATE INDEX IF NOT EXISTS stickers_enabled ON stickers(enabled, weight);
    `)
    this.backfillNtext()
  }

  /** Older rows predate the normalized-text column used for peer matching. */
  private backfillNtext(): void {
    const rows = this.db.prepare('SELECT seq, text FROM messages WHERE ntext IS NULL').all() as { seq: number, text: string }[]
    if (!rows.length) return
    const update = this.db.prepare('UPDATE messages SET ntext = ? WHERE seq = ?')
    this.db.exec('BEGIN')
    try {
      for (const row of rows) update.run(pairText(row.text), row.seq)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- kv / settings -------------------------------------------------------
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) as T : fallback
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
    if (key === 'settings') this.settingsCache = undefined
  }

  settings(): RuntimeSettings {
    if (!this.settingsCache) {
      const stored = this.get<Partial<RuntimeSettings>>('settings', {})
      const stickers = {
        ...structuredClone(DEFAULT_SETTINGS.stickers),
        ...stored.stickers,
        // An install that saved its settings before the type list existed (or
        // emptied it) must still get the built-in categories.
        types: stored.stickers?.types?.length ? stored.stickers.types : structuredClone(DEFAULT_SETTINGS.stickers.types),
      }
      // Two 表情 settings are gone for good: the per-hour send cap and the
      // short-lived "you have not sent one in N messages" nudge (the automatic
      // 表情 after a finished segment replaced both, see stickers.autoPercent).
      // A stored row that still carries them drops them here, so the panel's JSON
      // view cannot show a setting that no longer exists.
      const legacy = stickers as { perHour?: unknown, nudgeAfter?: unknown }
      delete legacy.perHour
      delete legacy.nudgeAfter
      this.settingsCache = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...stored,
        groups: { ...DEFAULT_SETTINGS.groups, ...stored.groups },
        // nested blocks merge too: a settings row written before a field existed
        // (or with an emptied sub-style pool) must not lose the defaults wholesale
        style: { ...structuredClone(DEFAULT_SETTINGS.style), ...stored.style },
        stickers,
      }
      if (stored.ownProjects) this.settingsCache.ownProjects = backfillProjects(stored.ownProjects)
    }
    return this.settingsCache
  }

  saveSettings(next: RuntimeSettings): void {
    this.set('settings', next)
  }

  /**
   * Effective settings for a conversation. A paired conversation is one physical
   * group seen through two bots: the panel shows both rows and the user may flip
   * the switch on either one, while only the owner side acts on it. Reads merge
   * with the twin, writes propagate (see updateGroup), so the two rows cannot
   * drift apart and silently disable a group.
   */
  group(conv: string): GroupSettings {
    const own = this.settings().groups[conv] ?? { whitelisted: false, dryRun: false, listen: false, tags: [], note: '' }
    const twin = own.peer ? this.settings().groups[own.peer] : undefined
    if (!twin) return own
    return {
      ...own,
      whitelisted: own.whitelisted || twin.whitelisted,
      listen: own.listen || twin.listen,
      dryRun: own.dryRun || twin.dryRun,
    }
  }

  updateGroup(conv: string, patch: Partial<GroupSettings>): GroupSettings {
    const settings = structuredClone(this.settings())
    const next = { ...this.group(conv), ...patch }
    settings.groups[conv] = next
    // mirror the switches onto the twin: typing /ai.white or clicking the panel row
    // on the history-only side must still arm the side that owns the triggers
    const twin = next.peer ? settings.groups[next.peer] : undefined
    if (twin) {
      if ('whitelisted' in patch) twin.whitelisted = next.whitelisted
      if ('listen' in patch) twin.listen = next.listen
      if ('dryRun' in patch) twin.dryRun = next.dryRun
    }
    this.saveSettings(settings)
    return next
  }

  // ---- messages ------------------------------------------------------------
  insertMessage(m: Omit<StoredMessage, 'seq'>): StoredMessage | undefined {
    const result = this.db.prepare(`INSERT OR IGNORE INTO messages(conv, id, sender_id, sender_name, ts, text, raw, reply_to, ntext, self, mentions_self, from_bot)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      m.conv, m.id, m.senderId, m.senderName, m.ts, m.text, m.raw, m.replyTo ?? null, pairText(m.text),
      m.self ? 1 : 0, m.mentionsSelf ? 1 : 0, m.fromBot ? 1 : 0,
    )
    if (!result.changes) return undefined
    this.db.prepare('UPDATE conversations SET last_ts = MAX(COALESCE(last_ts, 0), ?), count = count + 1 WHERE key = ?').run(m.ts, m.conv)
    return { ...m, seq: Number(result.lastInsertRowid) }
  }

  /**
   * Messages from the *other* platform with the same normalized text and a nearly
   * identical timestamp — the raw evidence for "these two conversations are one
   * physical group". Direct conversations cannot be a group twin.
   */
  twins(ntext: string, seq: number, ts: number, windowMs: number, prefix: string): { conv: string, senderName: string, ts: number }[] {
    const rows = this.db.prepare(`SELECT m.conv, m.sender_name, m.ts FROM messages m JOIN conversations c ON c.key = m.conv
      WHERE m.ntext = ? AND m.seq != ? AND m.conv LIKE ? AND c.direct = 0 AND ABS(m.ts - ?) <= ?
      ORDER BY ABS(m.ts - ?) LIMIT 8`).all(ntext, seq, `${prefix}%`, ts, windowMs, ts) as any[]
    return rows.map((r) => ({ conv: r.conv, senderName: r.sender_name ?? '', ts: r.ts }))
  }

  markFromBot(conv: string, id: string): void {
    this.db.prepare('UPDATE messages SET from_bot = 1 WHERE conv = ? AND id = ?').run(conv, id)
  }

  /**
   * Rewrite one row's `raw.forwards` (keeping the media list). Used when a merged forward that was
   * stored before the official side parsed them is recovered from its text: the parsed structure is
   * written back so it is done once, not on every read (see OrangeBot.forwardsOf).
   */
  setForwards(seq: number, forwards: unknown): void {
    const row = this.db.prepare('SELECT conv, raw FROM messages WHERE seq = ?').get(seq) as any
    if (!row) return
    let raw: any = {}
    try { raw = JSON.parse(row.raw || '{}') } catch { raw = {} }
    raw.forwards = forwards
    this.db.prepare('UPDATE messages SET raw = ? WHERE seq = ?').run(JSON.stringify(raw), seq)
  }

  private row(r: any): StoredMessage {
    return {
      seq: r.seq, conv: r.conv, id: r.id, senderId: r.sender_id, senderName: r.sender_name, ts: r.ts,
      text: r.text, raw: r.raw, replyTo: r.reply_to ?? undefined, self: !!r.self, mentionsSelf: !!r.mentions_self, fromBot: !!r.from_bot,
    }
  }

  bySeq(seq: number): StoredMessage | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(seq)
    return r ? this.row(r) : undefined
  }

  byId(conv: string, id: string): StoredMessage | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE conv = ? AND id = ?').get(conv, id)
    return r ? this.row(r) : undefined
  }

  recent(conv: string, limit: number, beforeSeq?: number): StoredMessage[] {
    const rows = beforeSeq
      ? this.db.prepare('SELECT * FROM messages WHERE conv = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(conv, beforeSeq, limit)
      : this.db.prepare('SELECT * FROM messages WHERE conv = ? ORDER BY seq DESC LIMIT ?').all(conv, limit)
    return rows.map((r) => this.row(r)).reverse()
  }

  after(conv: string, seq: number, limit = 200): StoredMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE conv = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(conv, seq, limit).map((r) => this.row(r))
  }

  /** How many messages arrived after `seq`, counted without loading them. */
  countAfter(conv: string, seq: number): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM messages WHERE conv = ? AND seq > ?').get(conv, seq) as { n: number }).n
  }

  search(opts: { conv?: string, convs?: string[], query?: string, sender?: string, since?: number, until?: number, limit: number }): StoredMessage[] {
    const where: string[] = []
    const args: any[] = []
    if (opts.conv) { where.push('conv = ?'); args.push(opts.conv) }
    if (opts.convs?.length) { where.push(`conv IN (${opts.convs.map(() => '?').join(',')})`); args.push(...opts.convs) }
    if (opts.query) { where.push('text LIKE ?'); args.push(`%${opts.query}%`) }
    if (opts.sender) { where.push('(sender_id = ? OR sender_name LIKE ?)'); args.push(opts.sender, `%${opts.sender}%`) }
    if (opts.since) { where.push('ts >= ?'); args.push(opts.since) }
    if (opts.until) { where.push('ts <= ?'); args.push(opts.until) }
    const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`
    return this.db.prepare(sql).all(...args, opts.limit).map((r) => this.row(r)).reverse()
  }

  findSimilar(conv: string, text: string, ts: number, windowMs = 15_000): StoredMessage | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE conv = ? AND ts BETWEEN ? AND ? AND text = ? ORDER BY ABS(ts - ?) LIMIT 1')
      .get(conv, ts - windowMs, ts + windowMs, text, ts)
    return r ? this.row(r) : undefined
  }

  /**
   * The twin-side row of one physical message: the same words at the same second, on the other
   * side of a paired group. Both platforms stamp one message with the same second-aligned time,
   * and the comparison runs on `ntext` — pairText() already drops quotes, mentions, media
   * placeholders and punctuation, so the two sides' differing renderings of the same message
   * (an @ here, a `[图片 #12]` there) still match; `twins()` pairs groups with the same evidence.
   * Words *and* second matching twice is not evidence (people repeat each other constantly), so an
   * ambiguous match yields nothing.
   */
  twinRow(conv: string, text: string, ts: number): StoredMessage | undefined {
    const ntext = pairText(text)
    if (!ntext) return undefined
    const rows = this.db.prepare('SELECT * FROM messages WHERE conv = ? AND ts = ? AND ntext = ? LIMIT 2').all(conv, ts, ntext)
    return rows.length === 1 ? this.row(rows[0]) : undefined
  }

  /**
   * Write a quote into a stored message, in exactly the shape the platform uses for its own
   * copies (`<quote>昵称：正文</quote> 正文`, see renderQuote in satori.ts). Used when the official
   * side dropped a reply's referenced body and the userbot side of the same group knows it — see
   * OrangeBot.borrowQuote. `ntext` needs no rewrite: pairText() strips quote blocks anyway.
   */
  setQuote(conv: string, id: string, text: string): void {
    this.db.prepare('UPDATE messages SET text = ? WHERE conv = ? AND id = ?').run(text, conv, id)
  }

  // ---- media ---------------------------------------------------------------
  /**
   * The stable id of one attachment. `key` is derived from where the attachment sits (message,
   * quote, or locator + path + position inside a forward), so rendering the same bundle twice —
   * the preview at ingest, `get_forward` later — hands out the *same* id instead of piling up
   * duplicates, and an id the model read long ago still resolves.
   */
  upsertMedia(key: string, m: Omit<MediaRow, 'id' | 'created' | 'updated'>): number {
    const now = Date.now()
    const row = this.db.prepare(`INSERT INTO media(media_key, conv, message_id, source, kind, name, mime, size, width, height, url, plan, created, updated)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_key) DO UPDATE SET kind = excluded.kind, name = excluded.name, mime = excluded.mime,
        size = excluded.size, width = excluded.width, height = excluded.height, url = excluded.url,
        plan = excluded.plan, updated = excluded.updated
      RETURNING id`).get(
      key, m.conv, m.messageId, m.source, m.kind, m.name ?? null, m.mime ?? null, m.size ?? null, m.width ?? null,
      m.height ?? null, m.url ?? null, m.plan ?? null, now, now,
    ) as { id: number } | undefined
    return Number(row?.id ?? 0)
  }

  media(id: number): MediaRow | undefined {
    const r = this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as any
    return r ? this.mediaRow(r) : undefined
  }

  /** Every attachment of one message, in the order it was registered (own, quote, forwards). */
  mediaOf(conv: string, messageId: string): MediaRow[] {
    const rows = this.db.prepare('SELECT * FROM media WHERE conv = ? AND message_id = ? ORDER BY id').all(conv, messageId) as any[]
    return rows.map((r) => this.mediaRow(r))
  }

  private mediaRow(r: any): MediaRow {
    return {
      id: Number(r.id), conv: r.conv, messageId: r.message_id, source: r.source, kind: r.kind,
      name: r.name ?? undefined, mime: r.mime ?? undefined, size: r.size ?? undefined,
      width: r.width ?? undefined, height: r.height ?? undefined, url: r.url ?? undefined,
      plan: r.plan ?? undefined, created: r.created, updated: r.updated,
    }
  }

  // ---- conversations -------------------------------------------------------
  upsertConversation(c: Omit<ConversationRow, 'lastTs' | 'count'>): void {
    this.db.prepare(`INSERT INTO conversations(key, platform, channel_id, title, title_src, direct, last_ts, count) VALUES(?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(key) DO UPDATE SET title = CASE WHEN excluded.title != '' THEN excluded.title ELSE conversations.title END,
        title_src = CASE WHEN excluded.title != '' THEN excluded.title_src ELSE conversations.title_src END`)
      .run(c.key, c.platform, c.channelId, c.title, c.titleSrc ?? c.platform, c.direct ? 1 : 0)
  }

  /** Metadata-only bump for a conversation whose content we deliberately do not store. */
  touchConversation(key: string, ts: number): void {
    this.db.prepare('UPDATE conversations SET last_ts = MAX(COALESCE(last_ts, 0), ?) WHERE key = ?').run(ts, key)
  }

  conversation(key: string): ConversationRow | undefined {
    const r: any = this.db.prepare('SELECT * FROM conversations WHERE key = ?').get(key)
    return r ? { key: r.key, platform: r.platform, channelId: r.channel_id, title: r.title, titleSrc: r.title_src ?? undefined, direct: !!r.direct, lastTs: r.last_ts, count: r.count, avatar: r.avatar ?? undefined } : undefined
  }

  conversations(): ConversationRow[] {
    return this.db.prepare('SELECT * FROM conversations ORDER BY last_ts DESC').all()
      .map((r: any) => ({ key: r.key, platform: r.platform, channelId: r.channel_id, title: r.title, titleSrc: r.title_src ?? undefined, direct: !!r.direct, lastTs: r.last_ts, count: r.count, avatar: r.avatar ?? undefined }))
  }

  /** Also used to name a configured conversation that has not seen a message yet. */
  setConversationTitle(key: string, title: string, src: string): void {
    this.db.prepare(`INSERT INTO conversations(key, platform, channel_id, title, title_src, direct, last_ts, count) VALUES(?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(key) DO UPDATE SET title = excluded.title, title_src = excluded.title_src`)
      .run(key, key.slice(0, 2), key.slice(3), title, src, src === 'dm' ? 1 : 0)
  }

  /**
   * Display name. Official-bot groups carry no name in their events, so a paired
   * conversation borrows the userbot twin's name — resolved at read time, never
   * copied into the row, so a corrected pairing cannot leave a stale name behind.
   * The same holds for private chats: the official C2C API sends no nickname, but
   * the person may have been seen (and named) in a group.
   */
  convTitle(key: string): string {
    const c = this.conversation(key)
    if (c?.title) return c.title
    if (c?.direct) {
      const name = this.user(key)?.name
      if (name && name !== c.channelId && !/^[0-9A-F]{32}$/i.test(name)) return name
      return ''
    }
    const peer = this.group(key).peer
    return peer ? (this.conversation(peer)?.title ?? '') : ''
  }

  /** Avatar, same idea: a paired official group can use the userbot group's public QQ avatar. */
  convAvatar(key: string): string | undefined {
    const own = this.conversation(key)?.avatar
    if (own) return own
    const peer = this.group(key).peer
    if (peer?.startsWith('cg:') && /^\d+$/.test(peer.slice(3))) return groupAvatar(peer.slice(3))
    return undefined
  }

  setConversationAvatar(key: string, avatar: string): void {
    this.db.prepare('UPDATE conversations SET avatar = ? WHERE key = ?').run(avatar, key)
  }

  clearConversationAvatar(key: string): void {
    this.db.prepare('UPDATE conversations SET avatar = NULL WHERE key = ?').run(key)
  }

  // ---- peer links ----------------------------------------------------------
  /**
   * Link a physical group's two views and mirror the switches, so flipping either
   * row in the panel arms the side that actually receives the triggers.
   */
  linkPeers(qq: string, cg: string): void {
    if (!qq.startsWith('qq:') || !cg.startsWith('cg:')) return
    const settings = structuredClone(this.settings())
    const qqOwn = settings.groups[qq]
    const cgGroup: GroupSettings = settings.groups[cg] ?? { whitelisted: false, dryRun: false, listen: false, tags: [], note: '' }
    // a brand-new official row inherits the userbot row's configuration
    settings.groups[qq] = qqOwn ? { ...qqOwn, peer: cg } : { ...cgGroup, peer: cg }
    settings.groups[cg] = { ...cgGroup, peer: qq }
    this.saveSettings(settings)
  }

  /** Drop a peer link without touching the switches (used when a pairing was wrong). */
  clearPeer(conv: string): string | undefined {
    const settings = structuredClone(this.settings())
    const gone = settings.groups[conv]?.peer
    if (!gone || !settings.groups[conv]) return undefined
    delete settings.groups[conv].peer
    this.saveSettings(settings)
    return gone
  }

  // ---- users ---------------------------------------------------------------
  /**
   * The people who have spoken in one conversation, newest first: the directory a mention the
   * agent writes (`@名字`, or the id tail a message line prints) is resolved against. `name` is
   * the last one this conversation saw, so a renamed account resolves under what people use.
   */
  senders(conv: string, limit = 500): { id: string, name: string }[] {
    const rows = this.db.prepare(`SELECT sender_id id, sender_name name, MAX(ts) last FROM messages
      WHERE conv = ? AND sender_id IS NOT NULL AND sender_id <> '' GROUP BY sender_id
      ORDER BY last DESC LIMIT ?`).all(conv, limit) as any[]
    return rows.map((r) => ({ id: String(r.id), name: String(r.name ?? '') }))
  }

  user(key: string): { key: string, name: string, tags: string[], note: string } | undefined {
    const r: any = this.db.prepare('SELECT * FROM users WHERE key = ?').get(key)
    return r ? { key: r.key, name: r.name, tags: JSON.parse(r.tags), note: r.note } : undefined
  }

  touchUser(key: string, name: string, avatar?: string): void {
    // An openid is not a name: never let it replace one we learned elsewhere (the
    // official C2C API sends no nickname, but the same person is named in groups).
    if (!name || name === key.slice(key.indexOf(':') + 1)) {
      this.db.prepare('INSERT INTO users(key, name, avatar, updated) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET avatar = COALESCE(excluded.avatar, users.avatar)')
        .run(key, name || key, avatar ?? null, Date.now())
      return
    }
    this.db.prepare(`INSERT INTO users(key, name, avatar, updated) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, avatar = COALESCE(excluded.avatar, users.avatar)`).run(key, name, avatar ?? null, Date.now())
  }

  setUserTag(key: string, tag: string, on: boolean): void {
    const user = this.user(key) ?? { key, name: key, tags: [], note: '' }
    const tags = new Set(user.tags)
    if (on) tags.add(tag); else tags.delete(tag)
    this.db.prepare(`INSERT INTO users(key, name, tags, updated) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET tags = excluded.tags, updated = excluded.updated`)
      .run(key, user.name, JSON.stringify([...tags]), Date.now())
  }

  users(): { key: string, name: string, tags: string[], note: string, avatar?: string }[] {
    return this.db.prepare('SELECT * FROM users ORDER BY updated DESC LIMIT 2000').all()
      .map((r: any) => ({ key: r.key, name: r.name, tags: JSON.parse(r.tags), note: r.note, avatar: r.avatar ?? undefined }))
  }

  // ---- group roles ---------------------------------------------------------
  /**
   * What each person is in one group (群主 / 群管理员 / 普通成员). Roles are per
   * conversation, because one physical group is two rows and the two platforms name
   * the same person differently; `source` records who told us (qq = the official
   * bot, cg = the userbot member list).
   */
  setMemberRole(conv: string, userId: string, role: string, source: string): void {
    this.db.prepare(`INSERT INTO member_roles(conv, user_id, role, source, updated) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(conv, user_id) DO UPDATE SET role = excluded.role, source = excluded.source, updated = excluded.updated`)
      .run(conv, userId, role, source, Date.now())
  }

  /**
   * Replace a whole conversation's roster with what the platform just reported, so a
   * demoted administrator really disappears instead of lingering as a stale role.
   */
  replaceMemberRoles(conv: string, rows: { id: string, role: string }[], source: string): void {
    const insert = this.db.prepare('INSERT INTO member_roles(conv, user_id, role, source, updated) VALUES(?, ?, ?, ?, ?)')
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM member_roles WHERE conv = ?').run(conv)
      for (const row of rows) insert.run(conv, row.id, row.role, source, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  memberRole(conv: string, userId: string): string | undefined {
    const r = this.db.prepare('SELECT role FROM member_roles WHERE conv = ? AND user_id = ?').get(conv, userId) as { role: string } | undefined
    return r?.role
  }

  /** Everyone a group told us about, privileged first (used for prompts and the panel). */
  memberRoles(conv: string, privilegedOnly = false): { userId: string, role: string, updated: number }[] {
    const rows = this.db.prepare(`SELECT user_id, role, updated FROM member_roles WHERE conv = ?
      ${privilegedOnly ? "AND role IN ('owner', 'administrator')" : ''}
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'administrator' THEN 1 ELSE 2 END, user_id`).all(conv) as any[]
    return rows.map((r) => ({ userId: r.user_id, role: r.role, updated: r.updated }))
  }

  // ---- events / memory -----------------------------------------------------
  addEvent(conv: string, text: string): void {
    this.db.prepare('INSERT INTO events(ts, conv, text) VALUES(?, ?, ?)').run(Date.now(), conv, text)
  }

  events(limit: number, exceptConv?: string): { id: number, ts: number, conv: string, text: string }[] {
    return (exceptConv
      ? this.db.prepare('SELECT * FROM events WHERE conv != ? ORDER BY id DESC LIMIT ?').all(exceptConv, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)).reverse() as any
  }

  /** Newest event id: a cursor, so a wake only repeats dynamics that actually changed. */
  maxEventId(): number {
    return (this.db.prepare('SELECT MAX(id) id FROM events').get() as { id: number | null } | undefined)?.id ?? 0
  }

  addMemory(scope: string, text: string): number {
    return Number(this.db.prepare('INSERT INTO memory(ts, scope, text) VALUES(?, ?, ?)').run(Date.now(), scope, text).lastInsertRowid)
  }

  deleteMemory(id: number): void {
    this.db.prepare('DELETE FROM memory WHERE id = ?').run(id)
  }

  memories(query?: string, limit = 50): { id: number, ts: number, scope: string, text: string }[] {
    return (query
      ? this.db.prepare('SELECT * FROM memory WHERE text LIKE ? OR scope LIKE ? ORDER BY id DESC LIMIT ?').all(`%${query}%`, `%${query}%`, limit)
      : this.db.prepare('SELECT * FROM memory ORDER BY id DESC LIMIT ?').all(limit)) as any
  }

  // ---- tasks ---------------------------------------------------------------
  createTask(t: { conv: string, title: string, kind: string, sessionId: string, repo?: string }): number {
    const now = Date.now()
    return Number(this.db.prepare('INSERT INTO tasks(created, updated, conv, title, kind, status, session_id, repo, issue, pr, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, \'\')')
      .run(now, now, t.conv, t.title, t.kind, 'running', t.sessionId, t.repo ?? null).lastInsertRowid)
  }

  updateTask(id: number, patch: Partial<{ status: string, issue: string, pr: string, note: string, repo: string, title: string }>): void {
    const keys = Object.keys(patch)
    if (!keys.length) return
    this.db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated = ? WHERE id = ?`).run(...keys.map((k) => (patch as any)[k]), Date.now(), id)
  }

  task(id: number): any { return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) }
  taskBySession(sessionId: string): any { return this.db.prepare('SELECT * FROM tasks WHERE session_id = ?').get(sessionId) }
  /**
   * Tasks that are still supposed to be alive: `running` (working, or a worker that
   * has not reported back yet) and `waiting` (asleep between wake-ups). Unlike
   * {@link tasks} this is not a "newest N" window — a task due in two days must not
   * drop off the list just because a hundred other tasks were created after it.
   */
  activeTasks(): any[] {
    return this.db.prepare("SELECT * FROM tasks WHERE status IN ('running', 'waiting') ORDER BY id DESC").all() as any[]
  }

  taskByPr(repo: string, pr: string): any {
    return this.db.prepare('SELECT * FROM tasks WHERE repo = ? AND (pr = ? OR pr LIKE ? OR issue = ? OR issue LIKE ?) ORDER BY id DESC LIMIT 1')
      .get(repo, pr, `%/${pr}`, pr, `%/${pr}`)
  }

  tasks(limit = 100, query?: string): any[] {
    return query
      ? this.db.prepare('SELECT * FROM tasks WHERE title LIKE ? OR note LIKE ? OR repo LIKE ? ORDER BY id DESC LIMIT ?').all(`%${query}%`, `%${query}%`, `%${query}%`, limit)
      : this.db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit)
  }

  // ---- stickers ------------------------------------------------------------
  private stickerRow(r: any): StickerRow {
    return {
      id: r.id, key: r.key, source: r.source, provider: r.provider, refId: r.ref_id, pack: r.pack ?? '',
      title: r.title ?? '', desc: r.desc_text ?? '', tags: JSON.parse(r.tags || '[]'), weight: r.weight ?? 50,
      enabled: !!r.enabled, format: r.format ?? 'static', mime: r.mime ?? '', width: r.width ?? 0, height: r.height ?? 0,
      size: r.size ?? 0, file: r.file ?? '', thumb: r.thumb ?? '', reference: r.reference ?? '',
      uses: r.uses ?? 0, lastUsed: r.last_used ?? 0, created: r.created ?? 0, updated: r.updated ?? 0, error: r.error ?? '',
    }
  }

  /** Insert a sticker, or return the existing row with the same `key` (idempotent import). */
  insertSticker(s: Omit<StickerRow, 'id' | 'uses' | 'lastUsed' | 'created' | 'updated' | 'error'> & { error?: string }): { row: StickerRow, inserted: boolean } {
    const now = Date.now()
    const result = this.db.prepare(`INSERT OR IGNORE INTO stickers(key, source, provider, ref_id, pack, title, desc_text, tags, weight, enabled,
      format, mime, width, height, size, file, thumb, reference, uses, last_used, created, updated, error)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`).run(
      s.key, s.source, s.provider, s.refId, s.pack, s.title, s.desc, JSON.stringify(s.tags), s.weight, s.enabled ? 1 : 0,
      s.format, s.mime, s.width, s.height, s.size, s.file, s.thumb, s.reference, now, now, s.error ?? '',
    )
    const row = this.stickerByKey(s.key)!
    return { row, inserted: !!result.changes }
  }

  stickerByKey(key: string): StickerRow | undefined {
    const r = this.db.prepare('SELECT * FROM stickers WHERE key = ?').get(key)
    return r ? this.stickerRow(r) : undefined
  }

  sticker(id: number): StickerRow | undefined {
    const r = this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id)
    return r ? this.stickerRow(r) : undefined
  }

  stickersByIds(ids: number[]): StickerRow[] {
    if (!ids.length) return []
    return this.db.prepare(`SELECT * FROM stickers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => this.stickerRow(r))
  }

  stickers(opts: { tags?: string[], untagged?: boolean, query?: string, enabled?: boolean, source?: string, ids?: number[], limit?: number, offset?: number, order?: string } = {}): StickerRow[] {
    const where: string[] = []
    const args: any[] = []
    if (opts.ids?.length) { where.push(`id IN (${opts.ids.map(() => '?').join(',')})`); args.push(...opts.ids) }
    if (opts.enabled !== undefined) { where.push('enabled = ?'); args.push(opts.enabled ? 1 : 0) }
    if (opts.source) { where.push('source = ?'); args.push(opts.source) }
    // The panel's 「未分类」 chip: the inverse of a type filter, for cleaning up
    // a pool where classification failed or was never run.
    if (opts.untagged) where.push(`(tags = '[]' OR tags IS NULL OR tags = '')`)
    if (opts.query) { where.push('(desc_text LIKE ? OR title LIKE ? OR tags LIKE ? OR pack LIKE ?)'); args.push(...Array(4).fill(`%${opts.query}%`)) }
    // Tags are ANDed: "无语 + 通用" means the sticker is both.
    for (const tag of opts.tags ?? []) { where.push('tags LIKE ?'); args.push(`%"${tag}"%`) }
    const order = { weight: 'weight DESC, uses ASC, id DESC', uses: 'uses DESC, weight DESC', newest: 'id DESC', oldest: 'id ASC' }[opts.order ?? 'weight'] ?? 'weight DESC, id DESC'
    const limit = Math.min(1000, opts.limit ?? 500)
    const rows = this.db.prepare(`SELECT * FROM stickers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, opts.offset ?? 0)
    return rows.map((r) => this.stickerRow(r))
  }

  /** How many stickers carry each tag (panel filter chips). */
  stickerTagCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT tags FROM stickers WHERE enabled = 1').all() as any[]) {
      for (const tag of JSON.parse(r.tags || '[]') as string[]) counts[tag] = (counts[tag] ?? 0) + 1
    }
    return counts
  }

  /** How many stickers the agent may actually pick from (prompt section, every turn). */
  enabledStickerCount(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM stickers WHERE enabled = 1').get() as any).n
  }

  stickerStats(): { total: number, enabled: number, bySource: Record<string, number>, byTag: Record<string, number>, undescribed: number, untagged: number } {
    const total = (this.db.prepare('SELECT COUNT(*) n FROM stickers').get() as any).n
    const enabled = (this.db.prepare('SELECT COUNT(*) n FROM stickers WHERE enabled = 1').get() as any).n
    const undescribed = (this.db.prepare("SELECT COUNT(*) n FROM stickers WHERE desc_text = ''").get() as any).n
    const untagged = (this.db.prepare("SELECT COUNT(*) n FROM stickers WHERE tags = '[]' OR tags IS NULL OR tags = ''").get() as any).n
    const bySource: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT source, COUNT(*) n FROM stickers GROUP BY source').all() as any[]) bySource[r.source ?? 'bridge'] = r.n
    return { total, enabled, bySource, byTag: this.stickerTagCounts(), undescribed, untagged }
  }

  updateSticker(id: number, patch: Partial<{ desc: string, tags: string[], weight: number, enabled: boolean, error: string, title: string, thumb: string }>): StickerRow | undefined {
    const sets: string[] = []
    const args: any[] = []
    if (patch.desc !== undefined) { sets.push('desc_text = ?'); args.push(patch.desc) }
    if (patch.tags !== undefined) { sets.push('tags = ?'); args.push(JSON.stringify(patch.tags)) }
    if (patch.weight !== undefined) { sets.push('weight = ?'); args.push(Math.max(0, Math.min(100, Math.round(patch.weight)))) }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0) }
    if (patch.error !== undefined) { sets.push('error = ?'); args.push(patch.error) }
    if (patch.title !== undefined) { sets.push('title = ?'); args.push(patch.title) }
    if (patch.thumb !== undefined) { sets.push('thumb = ?'); args.push(patch.thumb) }
    if (!sets.length) return this.sticker(id)
    this.db.prepare(`UPDATE stickers SET ${sets.join(', ')}, updated = ? WHERE id = ?`).run(...args, Date.now(), id)
    return this.sticker(id)
  }

  /** Forget a sticker entirely (the caller removes its files). */
  deleteStickers(ids: number[]): StickerRow[] {
    const rows = this.stickersByIds(ids)
    if (!rows.length) return []
    this.db.prepare(`DELETE FROM stickers WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id))
    return rows
  }

  /** Count one use, so "used recently" can be part of the pick and shown in the panel. */
  bumpStickerUse(id: number): void {
    this.db.prepare('UPDATE stickers SET uses = uses + 1, last_used = ? WHERE id = ?').run(Date.now(), id)
  }

  // ---- llm accounting ------------------------------------------------------
  recordLlm(c: { kind: string, model: string, input: number, cached: number, output: number, conv?: string, ref?: string }): void {
    this.db.prepare('INSERT INTO llm_calls(ts, kind, model, input, cached, output, cost, conv, ref) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), c.kind, c.model, c.input, c.cached, c.output, costUsd(c.input, c.cached, c.output), c.conv ?? null, c.ref ?? null)
  }

  stats(sinceMs: number): any {
    const since = Date.now() - sinceMs
    const byKind = this.db.prepare('SELECT kind, COUNT(*) calls, SUM(input) input, SUM(cached) cached, SUM(output) output, SUM(cost) cost FROM llm_calls WHERE ts >= ? GROUP BY kind').all(since)
    const hourly = this.db.prepare('SELECT (ts / 3600000) * 3600000 hour, SUM(cost) cost, COUNT(*) calls FROM llm_calls WHERE ts >= ? GROUP BY hour ORDER BY hour').all(since)
    const byConv = this.db.prepare('SELECT conv, SUM(cost) cost, COUNT(*) calls FROM llm_calls WHERE ts >= ? GROUP BY conv ORDER BY cost DESC LIMIT 20').all(since)
    const responses = this.db.prepare('SELECT COUNT(*) n, SUM(dry_run) dry FROM responses WHERE ts >= ?').get(since)
    const messages = this.db.prepare('SELECT COUNT(*) n FROM messages WHERE ts >= ?').get(since)
    return { byKind, hourly, byConv, responses, messages }
  }

  // ---- responses / classifications ----------------------------------------
  recordResponse(r: ResponseRow): number {
    return Number(this.db.prepare('INSERT INTO responses(ts, conv, trigger, trigger_seq, session_id, text, dry_run, delivered, error, context) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.ts, r.conv, r.trigger, r.triggerSeq ?? null, r.sessionId ?? null, r.text, r.dryRun ? 1 : 0, r.delivered ? 1 : 0, r.error ?? null, r.context ?? null).lastInsertRowid)
  }

  responses(conv?: string, limit = 100): any[] {
    return conv
      ? this.db.prepare('SELECT * FROM responses WHERE conv = ? ORDER BY id DESC LIMIT ?').all(conv, limit)
      : this.db.prepare('SELECT * FROM responses ORDER BY id DESC LIMIT ?').all(limit)
  }

  recordClassification(c: { conv: string, fromSeq: number, toSeq: number, wake: boolean, kind: string, reason: string }): void {
    this.db.prepare('INSERT INTO classifications(ts, conv, from_seq, to_seq, wake, kind, reason) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), c.conv, c.fromSeq, c.toSeq, c.wake ? 1 : 0, c.kind, c.reason)
  }

  classifications(conv?: string, limit = 100): any[] {
    return conv
      ? this.db.prepare('SELECT * FROM classifications WHERE conv = ? ORDER BY id DESC LIMIT ?').all(conv, limit)
      : this.db.prepare('SELECT * FROM classifications ORDER BY id DESC LIMIT ?').all(limit)
  }

  close(): void { this.db.close() }
}

/**
 * DeepSeek V4 Flash list price (USD / 1M tokens, peak; off-peak is half).
 * https://api-docs.deepseek.com/quick_start/pricing
 */
export const PRICE = { input: 0.3, cached: 0.006, output: 1.2 }

export function costUsd(input: number, cached: number, output: number): number {
  return (input * PRICE.input + cached * PRICE.cached + output * PRICE.output) / 1e6
}

/**
 * The project registry is persisted as a whole (any group edit rewrites the kv
 * row), so a field added to the built-in projects later would never reach an
 * install that already saved its projects. Fill `org`/`subs` in from the
 * defaults by name: an entry carrying its own value (including an empty `subs`)
 * wins, and a project deleted in the panel is not resurrected.
 */
function backfillProjects(stored: OwnProject[]): OwnProject[] {
  return stored.map((p) => {
    const def = DEFAULT_SETTINGS.ownProjects.find((d) => d.name.toLowerCase() === String(p.name).toLowerCase())
    if (!def) return p
    const merged: OwnProject = { ...p }
    if (merged.org === undefined) merged.org = def.org
    if (merged.subs === undefined && def.subs) merged.subs = structuredClone(def.subs)
    return merged
  })
}
