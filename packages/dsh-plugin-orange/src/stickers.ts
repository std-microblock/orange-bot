/**
 * The 表情 pool.
 *
 * Everything the bot may send as a sticker lives here: imports from the QQ
 * account's 收藏表情 collection (through crossgram's orange-ext routes on s0),
 * files dragged into the panel, the vision call that describes and tags each
 * one, and the pick/send/recall paths the agent tools use.
 *
 * Two things are worth knowing before reading:
 *  - a sticker imported from QQ keeps its *native* reference, so the userbot
 *    sends it as a real 表情 (see OutboundSticker in satori.ts) rather than as a
 *    picture; an uploaded file only has bytes and always goes out as an image.
 *  - image work (first-frame preview, the downscale handed to the vision model)
 *    shells out to ImageMagick, which the VM image already installs. It is
 *    best-effort: without it a sticker still imports, it just keeps no
 *    thumbnail and gets no automatic description.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { OrangeBot } from './bot.ts'
import type { StickerType } from './config.ts'
import type { StickerRow } from './store.ts'
import { chat, parseJsonLoose } from './llm.ts'
import { stickerClassifySystem } from './prompts.ts'
import type { InboundMessage, OutboundPart } from './satori.ts'

/** One 表情 as the s0 bridge describes it. */
export interface RemoteSticker {
  providerId: string
  stickerId: string
  packId?: string
  title?: string
  format?: string
  mimeType?: string
  width?: number
  height?: number
  size?: number
  /** Native send reference (JSON) — what makes it go out as a real QQ 表情. */
  reference?: unknown
  /** Direct CDN URL, when the bridge can resolve one (preferred: no byte relay). */
  url?: string
}

export interface StickerJob {
  id: string
  kind: 'import' | 'upload' | 'classify'
  total: number
  done: number
  skipped: number
  failed: number
  running: boolean
  cancelled: boolean
  started: number
  finished: number
  current: string
  errors: string[]
}

/** Max bytes of one sticker file we are willing to pull. */
const MAX_FETCH = 16 * 1024 * 1024
/** Stickers imported at once; the spec asks for at most three in flight. */
const IMPORT_CONCURRENCY = 3
/** Newest remote catalog is reused for this long (a full listing takes ~15s). */
const REMOTE_TTL_MS = 10 * 60_000

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
}

export class StickerService {
  /** Where the sticker bytes and their previews live. */
  readonly dir: string
  readonly thumbDir: string
  private readonly bot: OrangeBot
  private remoteCache?: { at: number, stickers: RemoteSticker[] }
  private job?: StickerJob
  private lastSent?: { conv: string, id: number }

  constructor(bot: OrangeBot) {
    this.bot = bot
    this.dir = join(bot.config.dataDir, 'stickers')
    this.thumbDir = join(this.dir, 'thumbs')
  }

  // ---- reads ---------------------------------------------------------------
  types(): StickerType[] { return this.bot.store.settings().stickers.types ?? [] }
  typeName(id: string): string { return this.types().find((t) => t.id === id)?.name ?? id }
  list(opts: Parameters<OrangeBot['store']['stickers']>[0] = {}): StickerRow[] { return this.bot.store.stickers(opts) }
  get(id: number): StickerRow | undefined { return this.bot.store.sticker(id) }
  stats() { return this.bot.store.stickerStats() }
  tagCounts() { return this.bot.store.stickerTagCounts() }
  jobState(): StickerJob | undefined { return this.job }
  lastSentSticker(): { conv: string, id: number } | undefined { return this.lastSent }

  /** Absolute path of a sticker's bytes (`thumb` = the small preview, when it exists). */
  filePath(row: StickerRow, thumb = false): string {
    return thumb && row.thumb ? join(this.thumbDir, row.thumb) : join(this.dir, row.file)
  }

  /**
   * The pool the agent picks from, as plain lines: id, types, weight and the
   * one-sentence description. Kept short on purpose — this is prompt text.
   */
  describe(rows: StickerRow[]): string {
    return rows.map((r) => `#${r.id} [${r.tags.map((t) => this.typeName(t)).join('/') || '未分类'}] 权重${r.weight} 用过${r.uses}次 ${r.desc || '(还没有描述)'}`).join('\n')
  }

  /**
   * What the agent may see and use: enabled stickers only. The panel calls
   * `list()` directly so it can show and re-enable the disabled ones; an agent
   * that could pick a turned-off 表情 would make the switch meaningless.
   */
  search(opts: { tags?: string[], query?: string, limit?: number, order?: string }): StickerRow[] {
    return this.list({ ...opts, enabled: true, limit: Math.min(60, opts.limit ?? 20) })
  }

  /**
   * Choose one sticker to send. `tags` narrows the pool (all must match), `hint`
   * is free text the agent wrote about the situation; it is matched against the
   * descriptions and type names. Ties are broken toward the heavier and the
   * less recently used, with a little randomness so the same 表情 does not come
   * back twice in a row.
   */
  pick(opts: { tags?: string[], hint?: string, exclude?: number[], minWeight?: number } = {}): StickerRow | undefined {
    const minWeight = opts.minWeight ?? this.bot.store.settings().stickers.minWeight ?? 0
    let pool = this.list({ enabled: true, tags: opts.tags, limit: 500 }).filter((r) => r.weight >= minWeight)
    if (opts.exclude?.length) pool = pool.filter((r) => !opts.exclude!.includes(r.id))
    if (!pool.length) return undefined
    const hint = String(opts.hint ?? '').trim().toLowerCase()
    const scored = pool.map((row) => ({ row, score: this.score(row, hint) }))
    const top = hint ? scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 8) : scored
    const candidates = top.length ? top : scored
    return weightedPick(candidates.map((s) => ({ row: s.row, weight: s.score || 1 })))
  }

  private score(row: StickerRow, hint: string): number {
    if (!hint) return 0
    const desc = row.desc.toLowerCase()
    let score = desc.includes(hint) ? 6 : 0
    for (const bigram of bigrams(desc)) if (bigram.length === 2 && hint.includes(bigram)) score += 1
    let typeScore = 0
    for (const tag of row.tags) {
      const type = this.types().find((t) => t.id === tag)
      const name = (type?.name ?? tag).toLowerCase()
      if (hint.includes(name) || name.includes(hint) || hint.includes(tag)) typeScore += 5
      // Descriptions are purely visual (see stickerClassifySystem), so a hint
      // like 「被逗笑了」 can only ever match the *type's* wording.
      const meaning = (type?.desc ?? '').toLowerCase()
      if (meaning && bigrams(meaning).some((pair) => pair.length === 2 && hint.includes(pair))) typeScore += 3
    }
    score += typeScore
    return score + (score > 0 ? row.weight / 100 : 0)
  }

  // ---- writes --------------------------------------------------------------
  update(id: number, patch: Parameters<OrangeBot['store']['updateSticker']>[1]): StickerRow | undefined {
    return this.bot.store.updateSticker(id, patch)
  }

  /** Forget stickers and delete their files (best effort — the row is the truth). */
  async remove(ids: number[]): Promise<number> {
    const rows = this.bot.store.deleteStickers(ids)
    for (const row of rows) {
      for (const path of [this.filePath(row), this.filePath(row, true)]) {
        if (path) await unlink(path).catch(() => {})
      }
    }
    return rows.length
  }

  // ---- sending -------------------------------------------------------------
  /**
   * Send one sticker. On the userbot it goes out as a native QQ 表情; the
   * official bot has no sticker API, so there the same bytes are sent as an
   * image (people see the same picture, it just is not a "real" 表情).
   */
  async send(row: StickerRow, conv: string, opts: { at?: { id: string, name?: string }[], quoteSeq?: number, replyTo?: InboundMessage, trigger?: string, sessionId?: string, automatic?: boolean } = {}): Promise<{ ids: string[], dryRun: boolean }> {
    const b = this.bot
    const parts: OutboundPart[] = []
    if (opts.quoteSeq) {
      const quoted = b.store.bySeq(Number(opts.quoteSeq))
      if (quoted && quoted.conv === conv) parts.push({ type: 'quote', messageId: quoted.id })
    }
    for (const person of opts.at ?? []) {
      parts.push({ type: 'at', userId: person.id, ...(person.name ? { name: person.name } : {}) }, { type: 'text', text: ' ' })
    }
    if (row.reference && !!this.bot.cgClient(conv)) {
      parts.push({
        type: 'sticker',
        sticker: {
          providerId: row.provider,
          stickerId: row.refId,
          packId: row.pack || undefined,
          name: row.title || row.desc.slice(0, 40) || row.refId,
          reference: encodeReference(row.reference),
        },
      })
    } else {
      parts.push({ type: 'image', src: this.filePath(row) })
    }
    const result = await b.send(conv, parts, {
      replyTo: opts.replyTo,
      trigger: opts.trigger ?? 'agent',
      sessionId: opts.sessionId,
      sticker: true,
      automatic: opts.automatic,
      stickerLabel: stickerLabel(row),
      context: `表情 #${row.id}｜${row.desc || '(无描述)'}${row.reference && !!this.bot.cgClient(conv) ? '' : '｜（这个平台不支持原生表情，按图片发出）'}`,
    })
    if (!result.dryRun) {
      b.store.bumpStickerUse(row.id)
      this.lastSent = { conv, id: row.id }
    }
    return result
  }

  // ---- remote catalog (QQ 收藏表情 through s0) ----------------------------
  /**
   * The QQ account's sticker catalog. The bridge walks the account's favorite
   * collection and probes each asset, which takes ~15s, so the answer is cached
   * and the panel asks for a refresh explicitly.
   */
  async remote(opts: { refresh?: boolean } = {}): Promise<{ stickers: RemoteSticker[], at: number, cached: boolean }> {
    const now = Date.now()
    if (!opts.refresh && this.remoteCache && now - this.remoteCache.at < REMOTE_TTL_MS) {
      return { ...this.remoteCache, cached: true }
    }
    const result = await this.bot.userbotClient()?.ext<{ stickers: RemoteSticker[], errors?: string[] }>('sticker.list', {})
    const stickers = (result?.stickers ?? []).filter((s) => s?.stickerId)
    this.remoteCache = { at: now, stickers }
    if (result?.errors?.length) this.bot.log.warn(`sticker.list: ${result.errors.join('; ')}`)
    return { stickers, at: now, cached: false }
  }

  // ---- jobs (import / upload / reclassify) --------------------------------
  /**
   * Start a background job. Only one runs at a time: the import is rate limited
   * to three in flight and the panel shows one progress bar, so a second job
   * would make both unreadable.
   */
  private start(kind: StickerJob['kind'], total: number): StickerJob {
    const job: StickerJob = {
      id: randomUUID().slice(0, 8), kind, total, done: 0, skipped: 0, failed: 0,
      running: true, cancelled: false, started: Date.now(), finished: 0, current: '', errors: [],
    }
    this.job = job
    this.emit(job)
    return job
  }

  cancel(): boolean {
    if (!this.job?.running) return false
    this.job.cancelled = true
    return true
  }

  private emit(job: StickerJob): void {
    this.bot.broadcast({ type: 'sticker-job', job: { ...job } })
  }

  /** Run `worker` over `items` with at most `limit` in flight, reporting progress. */
  private async run<T>(job: StickerJob, items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<StickerJob> {
    let index = 0
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        if (job.cancelled) return
        const i = index++
        if (i >= items.length) return
        try {
          await worker(items[i])
        } catch (error) {
          job.failed++
          job.errors.push(String((error as Error).message ?? error).slice(0, 200))
        } finally {
          job.done++
          this.emit(job)
        }
      }
    })
    await Promise.all(runners)
    job.running = false
    job.finished = Date.now()
    job.current = ''
    this.emit(job)
    return job
  }

  /**
   * Start importing the given remote stickers (identified by
   * `providerId|stickerId`). Returns as soon as the job exists — the caller is
   * the panel, which then follows the progress over SSE — and the work itself
   * runs three at a time, describing and tagging each sticker as it lands.
   */
  beginImport(keys: string[], opts: { classify?: boolean, refresh?: boolean } = {}): StickerJob {
    if (this.job?.running) throw new Error(`已经有一个表情任务在跑了（${this.job.kind} ${this.job.done}/${this.job.total}）`)
    const unique = [...new Set(keys.map(String).filter(Boolean))]
    if (!unique.length) throw new Error('没有选中任何表情')
    const job = this.start('import', unique.length)
    void this.runImport(job, unique, opts).catch((error) => this.fail(job, error))
    return job
  }

  private async runImport(job: StickerJob, keys: string[], opts: { classify?: boolean, refresh?: boolean }): Promise<void> {
    job.current = '读取 QQ 收藏表情列表…'
    this.emit(job)
    const catalog = await this.remote({ refresh: opts.refresh })
    const byKey = new Map(catalog.stickers.map((s) => [`${s.providerId}|${s.stickerId}`, s]))
    const wanted = keys.map((k) => byKey.get(k)).filter((s): s is RemoteSticker => !!s)
    if (!wanted.length) throw new Error('这些表情在 QQ 收藏列表里找不到了，先刷新一下列表')
    if (job.cancelled) { job.running = false; job.finished = Date.now(); this.emit(job); return }
    job.total = wanted.length
    await this.run(job, wanted, IMPORT_CONCURRENCY, async (remote) => {
      job.current = remote.title || remote.stickerId
      const row = await this.importOne(remote)
      if (!row) { job.skipped++; return }
      if (opts.classify !== false) await this.classify(row.id)
    })
  }

  /** Import one remote sticker (idempotent: the same QQ 表情 is stored once). */
  async importOne(remote: RemoteSticker): Promise<StickerRow | undefined> {
    const key = `${remote.providerId}:${remote.stickerId}`
    const existing = this.bot.store.stickerByKey(key)
    if (existing) return undefined
    const data = await this.fetchRemote(remote)
    const row = await this.saveBytes({
      key, source: 'bridge', provider: remote.providerId, refId: remote.stickerId, pack: remote.packId ?? '',
      title: remote.title ?? '', reference: remote.reference ? JSON.stringify(remote.reference) : '',
      mime: remote.mimeType ?? '', data,
    })
    return row
  }

  /** Save uploaded files, then describe/tag them in the background. */
  async addUploads(files: { name: string, data: Uint8Array }[]): Promise<{ ids: number[], job?: StickerJob }> {
    const saved: number[] = []
    for (const file of files) {
      const sha = createHash('sha1').update(file.data).digest('hex')
      const key = `upload:${sha}`
      const existing = this.bot.store.stickerByKey(key)
      if (existing) { saved.push(existing.id); continue }
      const row = await this.saveBytes({ key, source: 'upload', provider: 'upload', refId: sha, pack: '', title: file.name, reference: '', data: file.data })
      saved.push(row.id)
    }
    const todo = saved.filter((id) => !this.bot.store.sticker(id)?.desc)
    if (!todo.length || this.job?.running) return { ids: saved }
    try { return { ids: saved, job: this.beginClassify(todo) } } catch { return { ids: saved } }
  }

  /** (Re-)describe and re-tag stickers, three at a time. */
  beginClassify(ids: number[], opts: { force?: boolean } = {}): StickerJob {
    if (this.job?.running) throw new Error(`已经有一个表情任务在跑了（${this.job.kind} ${this.job.done}/${this.job.total}）`)
    const unique = [...new Set(ids)].filter((id) => !!this.bot.store.sticker(id))
    if (!unique.length) throw new Error('没有要分类的表情')
    const job = this.start('classify', unique.length)
    void this.run(job, unique, IMPORT_CONCURRENCY, async (id) => {
      job.current = `#${id}`
      await this.classify(id, opts.force)
    }).catch((error) => this.fail(job, error))
    return job
  }

  private fail(job: StickerJob, error: unknown): void {
    job.running = false
    job.finished = Date.now()
    job.errors.push(String((error as Error).message ?? error).slice(0, 200))
    this.bot.log.warn(`sticker ${job.kind}: ${(error as Error).message}`)
    this.emit(job)
  }

  // ---- classify ------------------------------------------------------------
  /**
   * Describe and tag one sticker with a vision call. The description is purely
   * what the picture looks like (the types carry the meaning — see
   * stickerClassifySystem); an animated one is shown as its first/middle/last
   * frame plus a 30-frame contact sheet, so the model can describe the motion
   * instead of guessing from frame 1. Failures are recorded on the row (`error`)
   * and never block an import.
   */
  async classify(id: number, force = false): Promise<StickerRow | undefined> {
    const store = this.bot.store
    const row = store.sticker(id)
    if (!row) return undefined
    if (row.desc && !force) return row
    const types = this.types()
    const frames = await this.visionFrames(row).catch(() => [])
    if (!frames.length) return store.updateSticker(id, { error: '图片读不出来（没有 ImageMagick 或者格式不支持），需要手写描述' })
    const model = String(store.settings().stickers.model ?? '').trim() || this.bot.config.llm.model
    const cfg = { baseURL: this.bot.config.llm.baseURL, apiKey: this.bot.config.llm.apiKey, model }
    const what = frames.length === 1 ? '这是一张静态表情。' : `这是一张动图，按顺序给你 ${frames.length} 张图：第 1 张是第一帧，第 2 张是中间帧，第 3 张是最后一帧，第 4 张是把整段动画均匀采样 30 帧拼成的网格图（从左到右、从上到下就是时间顺序）。`
    const messages = [
      { role: 'system' as const, content: stickerClassifySystem(types) },
      { role: 'user' as const, content: [
        { type: 'text' as const, text: `${what}给这张表情打类型标签，并写一句话描述。` },
        ...frames.map((frame) => ({ type: 'image_url' as const, image_url: { url: `data:${frame.mime};base64,${frame.data.toString('base64')}` } })),
      ] },
    ]
    // A reasoning model spends output tokens thinking before it writes the JSON;
    // on a four-image animated 表情 that can eat a small budget and come back with
    // empty content (finish_reason=length), which is not an error the retry layer
    // would catch — so the answer is checked and asked for once more, with room.
    const usage = { input: 0, cached: 0, output: 0 }
    let text = ''
    try {
      for (const maxTokens of [3000, 8000]) {
        const result = await chat(cfg, messages, { json: true, maxTokens, temperature: 0.2, timeoutMs: 180_000, retries: 1 })
        usage.input += result.input; usage.cached += result.cached; usage.output += result.output
        text = result.text
        if (text.trim()) break
        this.bot.log.warn(`sticker classify #${id}: 模型没吐出内容（${frames.length} 张画面，max_tokens=${maxTokens}），再试一次`)
      }
      store.recordLlm({ kind: 'sticker', model, input: usage.input, cached: usage.cached, output: usage.output })
      const parsed = parseJsonLoose<{ tags?: unknown, desc?: unknown }>(text)
      const known = new Set(types.map((t) => t.id))
      const tags = Array.isArray(parsed?.tags)
        ? [...new Set(parsed!.tags.map((t) => String(t).trim()).filter((t) => known.has(t)))].slice(0, 3)
        : []
      const desc = String(parsed?.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!desc && !tags.length) return store.updateSticker(id, { error: `模型没给出可用结果：${text.slice(0, 120) || '(空回答)'}` })
      const next = store.updateSticker(id, { desc: desc || row.desc, tags: tags.length ? tags : row.tags, error: '' })
      this.bot.broadcast({ type: 'sticker', id })
      return next
    } catch (error) {
      this.bot.log.warn(`sticker classify #${id}: ${(error as Error).message}`)
      return store.updateSticker(id, { error: `分类失败：${(error as Error).message}`.slice(0, 200) })
    }
  }

  // ---- image plumbing ------------------------------------------------------
  /**
   * The frames handed to the vision model. A still image is one downscaled JPEG;
   * an animation is first/middle/last plus a contact sheet of up to 30 evenly
   * sampled frames, which is what lets the model describe a motion at all (a
   * single GIF frame is usually just a face). A 5 MB animated GIF becomes four
   * images of ~25–110 KB.
   */
  private async visionFrames(row: StickerRow): Promise<{ data: Buffer, mime: string }[]> {
    const path = this.filePath(row)
    const frames = await frameCount(path)
    if (frames <= 1) {
      const single = await still(path)
      if (single) return [single]
      return this.rawFallback(row, path)
    }
    const picks = sampleIndices(frames, 30)
    const images: { data: Buffer, mime: string }[] = []
    for (const index of [0, Math.floor((frames - 1) / 2), frames - 1]) {
      const frame = await still(`${path}[${index}]`)
      if (frame) images.push(frame)
    }
    const sheet = await contactSheet(path, picks)
    if (sheet) images.push(sheet)
    return images.length >= 2 ? images : this.rawFallback(row, path)
  }

  /** No ImageMagick (or an undecodable format): the stored bytes, if the model will take them. */
  private async rawFallback(row: StickerRow, path: string): Promise<{ data: Buffer, mime: string }[]> {
    const raw = await readFile(path).catch(() => undefined)
    if (!raw || raw.length > 3_000_000) return []
    const mime = row.mime || sniffMime(raw)
    return mime?.startsWith('image/') ? [{ data: raw, mime }] : []
  }

  /** Store the bytes, make a preview, insert the row. */
  private async saveBytes(input: {
    key: string, source: 'bridge' | 'upload', provider: string, refId: string, pack: string,
    title: string, reference: string, mime?: string, data: Uint8Array,
  }): Promise<StickerRow> {
    const mime = input.mime && input.mime !== 'application/octet-stream' ? input.mime : (sniffMime(input.data) ?? 'application/octet-stream')
    const sha = createHash('sha1').update(input.data).digest('hex')
    const file = `${sha}.${MIME_EXT[mime] ?? (extname(input.refId).replace('.', '') || 'bin')}`
    await mkdir(this.thumbDir, { recursive: true })
    await writeFile(join(this.dir, file), input.data)
    const thumb = await this.makeThumb(file, sha)
    const size = await imageSize(join(this.dir, file))
    const { row } = this.bot.store.insertSticker({
      key: input.key, source: input.source, provider: input.provider, refId: input.refId, pack: input.pack,
      title: input.title, desc: '', tags: [], weight: 50, enabled: true,
      format: mime === 'image/gif' || mime === 'image/webp' ? 'animated' : 'static',
      mime, width: size?.width ?? 0, height: size?.height ?? 0, size: input.data.byteLength,
      file, thumb, reference: input.reference,
    })
    this.bot.broadcast({ type: 'sticker', id: row.id })
    return row
  }

  /** A first-frame PNG preview for the panel; '' when ImageMagick is unavailable. */
  private async makeThumb(file: string, sha: string): Promise<string> {
    const name = `${sha}.png`
    const out = await run('magick', [`${join(this.dir, file)}[0]`, '-resize', '240x240>', '-strip', 'png:-'])
    if (out.code !== 0 || !out.stdout.length) return ''
    await writeFile(join(this.thumbDir, name), out.stdout).catch(() => {})
    return name
  }

  /** Pull one remote sticker's bytes: the CDN URL first, the bridge as fallback. */
  private async fetchRemote(remote: RemoteSticker): Promise<Buffer> {
    const failures: string[] = []
    if (remote.url) {
      try { return await fetchBytes(remote.url) } catch (error) { failures.push(`url: ${(error as Error).message}`) }
    }
    try {
      const asset = await this.bot.userbotClient()?.ext<{ data: string, mimeType?: string }>('sticker.asset', { providerId: remote.providerId, stickerId: remote.stickerId })
      if (!asset?.data) throw new Error('bridge returned no bytes')
      return Buffer.from(asset.data, 'base64')
    } catch (error) {
      failures.push(`bridge: ${(error as Error).message}`)
    }
    throw new Error(failures.join(' / '))
  }
}

// ---------------------------------------------------------------- helpers ---

/**
 * One burst of the bot's own messages in a conversation. The automatic 表情
 * fires when such a burst ends, so all it has to know is how much the bot said
 * and whether it already put a 表情 in there itself.
 */
export interface MessageSegment {
  /** Messages the bot sent into this segment. */
  messages: number
  /** A 表情 went out inside it: the closing one would be noise. */
  sticker: boolean
}

/**
 * Whether a finished segment earns an automatic 表情: it has to contain something
 * the bot actually said (a 表情 on its own is a complete reply and needs no
 * garnish), must not already carry a 表情 the agent picked itself, and has to
 * pass the configured chance. `roll` is the die (0 ≤ roll < 1) so callers can
 * test the rule without repeating themselves.
 */
export function segmentWantsSticker(seg: MessageSegment, percent: number, roll: number): boolean {
  if (seg.sticker || seg.messages <= 0) return false
  const chance = Math.min(100, Math.max(0, Number(percent) || 0))
  return roll * 100 < chance
}

/**
 * The bot's message segments, one per conversation: every message it sends
 * restarts a `gapMs` timer, and when that timer finally fires the burst counts
 * as finished (this is the 7s debounce — two messages three seconds apart are
 * one segment, the same two with ten seconds between them are two).
 *
 * Only the bot's *own* sends take part: the group's traffic is not a segment,
 * otherwise the bot would be decorating conversations it is not even in kind of.
 * A 表情 neither counts as a message nor opens a segment of its own (an opening
 * would only schedule another pointless roll for a segment with nothing in it);
 * it just marks the open one, which is what keeps the automatic 表情 from
 * doubling up on the agent's own choice.
 *
 * The timers are injectable so tests can drive segments without waiting.
 */
export class MessageSegments {
  private open?: { timer: unknown, seg: MessageSegment }
  private readonly gapMs: () => number
  private readonly onClose: (seg: MessageSegment) => void
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(
    gapMs: () => number,
    onClose: (seg: MessageSegment) => void,
    // wrapped rather than handed over directly: node's timer functions take
    // concrete handle types, and the handle here is deliberately opaque
    setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer: unknown) => void = (timer) => clearTimeout(timer as NodeJS.Timeout),
  ) {
    this.gapMs = gapMs
    this.onClose = onClose
    this.setTimer = setTimer
    this.clearTimer = clearTimer
  }

  /** The bot sent a message (not a 表情). */
  message(): void {
    const seg = this.open?.seg ?? { messages: 0, sticker: false }
    seg.messages++
    this.arm(seg)
  }

  /** The bot sent a 表情 — its own pick, or the automatic one this class triggers. */
  sticker(): void {
    const seg = this.open?.seg ?? { messages: 0, sticker: false }
    seg.sticker = true
    this.arm(seg)
  }

  /** Drop the pending timer (shutdown); the open segment is simply forgotten. */
  stop(): void {
    if (!this.open) return
    this.clearTimer(this.open.timer)
    this.open = undefined
  }

  private arm(seg: MessageSegment): void {
    if (this.open) this.clearTimer(this.open.timer)
    this.open = { timer: this.setTimer(() => this.close(seg), this.gapMs()), seg }
  }

  private close(seg: MessageSegment): void {
    // The snapshot is what the caller sees; the open slot goes back to empty so
    // the next message starts a fresh segment.
    this.open = undefined
    this.onClose({ messages: seg.messages, sticker: seg.sticker })
  }
}

/**
 * The identity of one 表情, as it is recorded everywhere we log or store a send:
 * `#158 趴在地上摊平的兽耳少女，红眼半睁`. The id is what `send_sticker` takes back,
 * and the short description is what makes a line of history readable — without
 * it the same 表情 sent twice is indistinguishable from any other, and the
 * automatic ones in particular would be untraceable to the agent that "sent"
 * them (see OrangeBot.send).
 */
export function stickerLabel(row: StickerRow): string {
  const desc = String(row.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)
  return `#${row.id}${desc ? ` ${desc}` : ''}`
}

/** base64url of the reference JSON, exactly what satori-exporter decodes. */
export function encodeReference(reference: string): string {
  const parsed = JSON.parse(reference)
  return Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url')
}

/** Characters pairs of a short Chinese description, for fuzzy hint matching. */
export function bigrams(text: string): string[] {
  const clean = text.replace(/[\s，。、！？的了吗呢]/g, '')
  const out: string[] = []
  for (let i = 0; i + 2 <= clean.length; i++) out.push(clean.slice(i, i + 2))
  return out
}

/**
 * Up to `count` frame indices spread evenly across `[0, frames-1]`, ends
 * included: that is the sampling the contact sheet uses (ImageMagick's `%s`
 * frame selector addresses frames by these numbers).
 */
export function sampleIndices(frames: number, count: number): number[] {
  if (frames <= 1) return [0]
  const wanted = Math.min(frames, Math.max(2, count))
  const picked = new Set<number>()
  for (let i = 0; i < wanted; i++) picked.add(Math.round((i * (frames - 1)) / (wanted - 1)))
  return [...picked].sort((a, b) => a - b)
}

/** How many frames an image file holds (1 for anything still). */
export async function frameCount(path: string): Promise<number> {
  const out = await run('magick', ['identify', '-format', '%s\n', path])
  if (out.code !== 0) return 0
  const lines = out.stdout.toString('utf8').split('\n').filter((line) => line.trim() !== '')
  return lines.length || 0
}

/** One frame (or a whole still image) as a downscaled opaque JPEG for the model. */
export async function still(selector: string, size = 512): Promise<{ data: Buffer, mime: string } | undefined> {
  const out = await run('magick', [selector, '-resize', `${size}x${size}>`, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-strip', '-quality', '80', 'jpeg:-'])
  return out.code === 0 && out.stdout.length ? { data: out.stdout, mime: 'image/jpeg' } : undefined
}

/**
 * The contact sheet: the sampled frames tiled six to a row, in time order. This
 * is what makes an animation legible to the model — a motion described from 30
 * frames, not from one.
 */
export async function contactSheet(path: string, frames: number[], columns = 6): Promise<{ data: Buffer, mime: string } | undefined> {
  if (frames.length < 2) return undefined
  const args = ['montage', ...frames.map((index) => `${path}[${index}]`), '-tile', `${columns}x`, '-geometry', '96x96+2+2', '-background', 'white', '-strip', '-quality', '78', 'jpeg:-']
  const out = await run('magick', args)
  return out.code === 0 && out.stdout.length ? { data: out.stdout, mime: 'image/jpeg' } : undefined
}

/**
 * Pick one entry by weight, softened by how recently it was used: the heaviest
 * sticker in the pool should not be the only one that ever goes out.
 */
export function weightedPick<T extends { row: StickerRow, weight: number }>(entries: T[]): StickerRow | undefined {
  if (!entries.length) return undefined
  const now = Date.now()
  const scored = entries.map((e) => {
    const age = e.row.lastUsed ? now - e.row.lastUsed : Infinity
    const penalty = age < 5 * 60_000 ? 0.25 : age < 3600_000 ? 0.6 : age < 86400_000 ? 0.85 : 1
    return { row: e.row, score: (e.weight + 5) * penalty * (0.85 + Math.random() * 0.3) }
  })
  const total = scored.reduce((sum, s) => sum + s.score, 0)
  let roll = Math.random() * total
  for (const entry of scored) {
    roll -= entry.score
    if (roll <= 0) return entry.row
  }
  return scored[scored.length - 1].row
}

export function sniffMime(data: Uint8Array): string | undefined {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif'
  if (data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'
  return undefined
}

/** Fetch one asset with a size cap and a timeout (the QQ CDN is usually fast). */
export async function fetchBytes(url: string, maxBytes = MAX_FETCH): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  if (data.byteLength > maxBytes) throw new Error(`too large (${data.byteLength} bytes)`)
  if (!data.byteLength) throw new Error('empty body')
  return data
}

/** ImageMagick's idea of a file's size, or undefined when it cannot tell. */
export async function imageSize(path: string): Promise<{ width: number, height: number } | undefined> {
  const out = await run('magick', ['identify', '-format', '%w %h', `${path}[0]`])
  if (out.code !== 0) return undefined
  const [width, height] = out.stdout.toString('utf8').trim().split(/\s+/).map(Number)
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined
}

/** Run a binary and collect stdout. Never throws: callers treat failure as "no tool". */
export function run(bin: string, args: string[], timeoutMs = 60_000): Promise<{ code: number, stdout: Buffer, stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String((error as Error).message) })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 32 * 1024 * 1024) chunks.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }) })
  })
}
