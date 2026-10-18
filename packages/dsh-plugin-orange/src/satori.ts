/**
 * Satori bridge. Two adapters normalize koishi (QQ official bot, `qq:`) and
 * crossgram (userbot, `cg:`) into one message model. Conversation keys are
 * `qq:<group_openid|user_openid>` and `cg:<group number|user id>`; ids from one
 * platform are never valid on the other.
 */
import WebSocket from 'ws'
import h from '@satorijs/element'
import type { SatoriEndpoint } from './config.ts'
import { foldMentions, markdownDropsQuote } from './qq.ts'
import { bundlePreview, forwardPlaceholder, mediaTag, parseForwardDump, type BundleItem } from './media.ts'

export type PlatformKey = 'qq' | 'cg'

/**
 * A group role that matters to the bot: the owner (群主) and the administrators
 * (群管理员) a platform reports. QQ calls the second one `admin`, crossgram calls it
 * `administrator`; both land here as `administrator`. Ordinary members are simply
 * the absence of a role (or a stored `member`).
 */
export type MemberRole = 'owner' | 'administrator' | 'member'

/** Normalize whatever a platform calls a group role. */
export function memberRole(raw: unknown): MemberRole | undefined {
  switch (String(raw ?? '').trim().toLowerCase()) {
    case 'owner': return 'owner'
    case 'admin': case 'administrator': return 'administrator'
    case 'member': return 'member'
    default: return undefined
  }
}

export interface MediaRef { kind: 'image' | 'file' | 'video' | 'audio', url: string, name?: string, mime?: string }

/** One attachment as a renderer sees it, before the message it belongs to is attached. */
export interface MediaSpec {
  /** Where it sat: in the message itself, in the message it quotes, or inside a merged forward. */
  source: 'message' | 'quote' | 'forward'
  /** image | file | video | audio — what the media is, not how it is labelled. */
  kind: string
  name?: string
  mime?: string
  size?: number
  width?: number
  height?: number
  /** A directly usable address; a forward attachment needs `plan` instead (see store.MediaRow). */
  url?: string
  /** JSON resolution plan: how to ask for this attachment's url again. */
  plan?: string
}

/**
 * An attachment plus the message it came from. The bot turns every one of these into a row with
 * a stable id (see media.ts, `OrangeBot.mediaId`) and the renderer prints that id on the spot —
 * `[图片 #12]` — so the agent can ask for any picture later by id, no matter which message, quote
 * or forward it came from. Without a sink the old per-message `[图片#n]` numbering is kept, which
 * is what the offline tests run on.
 */
export interface MediaEntry extends MediaSpec {
  conv: string
  messageId: string
  ts: number
  senderName: string
}

export type MediaSink = (entry: MediaEntry) => number
/** What a renderer is handed: the context of the message is filled in by its caller. */
export type MediaSpecSink = (spec: MediaSpec) => number

export interface InboundMessage {
  platform: PlatformKey
  conv: string
  channelId: string
  direct: boolean
  title: string
  id: string
  senderId: string
  senderName: string
  senderAvatar?: string
  ts: number
  /** Compact text for models, with inline tags. */
  text: string
  raw: unknown
  replyTo?: string
  mentionsSelf: boolean
  self: boolean
  /**
   * The sender's role in this group, when the platform handed it to us: the QQ
   * official bot puts `member_role` into every group message event, the userbot
   * side has to ask (see OrangeBot.refreshRoles).
   */
  senderRole?: MemberRole
  media: MediaRef[]
  /**
   * Media of the quoted message, when the platform handed us the quote as data instead of
   * as rendered text (QQ groups — see `renderQuote`). Kept out of `media`: the message's own
   * attachments and the quoted ones get independent ids anyway (see media.ts).
   */
  quotedMedia?: MediaRef[]
  /**
   * Merged forwards in this message. The userbot side gives a `locator` the platform can be
   * asked for the bundle again; the official side hands over nothing but that rendered text, so
   * the parsed `snapshot` is all we will ever have of it (see parseForwardDump).
   */
  forwards: { id: string, title: string, preview?: string, locator?: unknown, snapshot?: BundleItem[] }[]
  /** Raw message ref used by the qq passive-reply mechanism. */
  eventId?: string
}

/**
 * One sticker to send. Only the userbot can send a *native* QQ 表情: Satori
 * carries it as an `<img>` with the five `data-crossgram-sticker-*` attributes
 * that crossgram's exporter turns back into a sticker part, and `reference` is
 * the base64url(JSON) payload those attributes match against (see stickers.ts).
 */
export interface OutboundSticker {
  providerId: string
  stickerId: string
  packId?: string
  name: string
  reference: string
}

export interface OutboundPart {
  type: 'text' | 'image' | 'file' | 'markdown' | 'buttons' | 'at' | 'quote' | 'sticker'
  text?: string
  /** data: URL, https URL, or local absolute path */
  src?: string
  /** A file's name — or, on an `at` part, the nickname of the person being mentioned. */
  name?: string
  /** `at`: the platform id to mention (a QQ member openid, or a userbot NT uid). */
  userId?: string
  messageId?: string
  buttons?: { label: string, kind: 'link' | 'input' | 'callback', data: string }[][]
  sticker?: OutboundSticker
}

type Listener = (message: InboundMessage) => void

const MAX_BACKOFF = 60_000

abstract class SatoriClient {
  selfId = ''
  /**
   * The id the Satori API authenticates with, when it differs from `selfId`:
   * crossgram's userbot registers its bot under the numeric QQ id while messages,
   * mentions and senders carry the opaque platform id (see the ready frame in
   * orange-ext). Only the API header uses it — mention detection uses `selfId`.
   */
  loginId = ''
  protected ws?: WebSocket
  private seq = 0
  private stopped = false
  private backoff = 1000
  private heartbeat?: NodeJS.Timeout
  protected listeners = new Set<Listener>()
  onStatus?: (status: string) => void
  /** Called whenever we learn/refresh our own id, so it can be persisted. */
  onSelfId?: (id: string) => void
  /**
   * Where an attachment goes to get its stable id. Installed by the bot (see OrangeBot.mediaId);
   * without it every renderer falls back to printing a position inside this one message.
   */
  onMedia?: MediaSink

  constructor(readonly platform: PlatformKey, protected readonly cfg: SatoriEndpoint, protected readonly log: (level: 'info' | 'warn', msg: string) => void) {}

  /** Binds this client's media sink to the message currently being rendered. */
  protected mediaSink(context: Omit<MediaEntry, keyof MediaSpec>): MediaSpecSink | undefined {
    const sink = this.onMedia
    return sink ? (spec) => sink({ ...spec, ...context }) : undefined
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.heartbeat)
    this.ws?.close()
  }

  protected abstract eventsUrl(): string
  protected abstract identify(ws: WebSocket): void
  protected abstract handleFrame(frame: any): void

  private connect(): void {
    if (this.stopped) return
    const ws = new WebSocket(this.eventsUrl())
    this.ws = ws
    ws.on('open', () => {
      this.backoff = 1000
      this.identify(ws)
      clearInterval(this.heartbeat)
      this.heartbeat = setInterval(() => this.ping(ws), 10_000)
    })
    ws.on('message', (data) => {
      let frame: any
      try { frame = JSON.parse(String(data)) } catch { return }
      try { this.handleFrame(frame) } catch (error) { this.log('warn', `${this.platform} frame error: ${(error as Error).stack}`) }
    })
    ws.on('close', (code, reason) => {
      clearInterval(this.heartbeat)
      if (this.stopped) return
      this.onStatus?.(`disconnected ${code} ${reason}`)
      this.log('warn', `${this.platform} events closed ${code} ${reason}; reconnect in ${this.backoff}ms`)
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(MAX_BACKOFF, this.backoff * 2)
    })
    ws.on('error', (error) => this.log('warn', `${this.platform} events error: ${error.message}`))
  }

  protected ping(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1 }))
  }

  protected emit(message: InboundMessage): void {
    for (const listener of this.listeners) {
      try { listener(message) } catch (error) { this.log('warn', `listener error: ${(error as Error).stack}`) }
    }
  }

  protected nextSeq(sn?: number): void { if (sn) this.seq = Math.max(this.seq, sn) }

  async api<T = any>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.cfg.endpoint}/v1/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
        'Satori-Platform': 'qq',
        // The Satori server looks the bot up by this id, and it is not always the
        // platform's opaque user id: crossgram registers the userbot under its
        // numeric QQ id when the adapter knows one (see `loginId` in the ready frame).
        'Satori-User-ID': this.loginId || this.selfId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${this.platform} ${method} ${response.status}: ${text.slice(0, 500)}`)
    return text ? JSON.parse(text) : undefined as T
  }

  async ext<T = any>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.cfg.endpoint}/orange/${method}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const json: any = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
    if (!json.ok) throw new Error(`${this.platform} ext ${method}: ${json.error}`)
    return json.result as T
  }

  abstract send(channelId: string, direct: boolean, parts: OutboundPart[], replyTo?: InboundMessage): Promise<string[]>
}

/**
 * Compact, model-facing rendering of Satori elements. With a `sink` every attachment is printed
 * as `[图片 #12]` (the stable id it just got); without one the old `[图片#1]` position inside this
 * message is kept, which is what the offline tests use.
 */
export function renderElements(elements: h[], selfIds: string[], sink?: MediaSpecSink): { text: string, media: MediaRef[], mentionsSelf: boolean, replyTo?: string } {
  const media: MediaRef[] = []
  let mentionsSelf = false
  let replyTo: string | undefined
  const place = (kind: MediaRef['kind'], url: string, name?: string, mime?: string, sticker = false): string => {
    media.push(kind === 'file' ? { kind, url, name } : kind === 'image' ? { kind, url, mime } : { kind, url })
    const id = sink?.({ source: 'message', kind, url, name, mime })
    if (id) return mediaTag(id, sticker ? 'sticker' : kind, name)
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '语音' : '文件'
    return sticker ? `[表情#${media.length}]` : name && kind !== 'image' ? `[${label}#${media.length} ${name}]` : `[${label}#${media.length}]`
  }
  const visit = (nodes: h[]): string => nodes.map((node) => {
    switch (node.type) {
      case 'text': return String(node.attrs.content ?? '')
      case 'br': return '\n'
      case 'p': return visit(node.children) + '\n'
      case 'at': {
        const id = String(node.attrs.id ?? '')
        if (node.attrs.type === 'all') return '@全体成员'
        if (selfIds.includes(id)) { mentionsSelf = true; return '[@我]' }
        return `@${node.attrs.name ?? id}`
      }
      case 'quote': {
        if (node.attrs.id) replyTo = String(node.attrs.id)
        return node.children.length ? `<quote>${visit(node.children).slice(0, 120)}</quote>` : ''
      }
      case 'img': case 'image': {
        const url = String(node.attrs.src ?? node.attrs.url ?? '')
        const sticker = node.attrs['data-crossgram-sticker-id'] || node.attrs.dataCrossgramStickerId
        return place('image', url, undefined, node.attrs.type, !!sticker)
      }
      case 'file': {
        const url = String(node.attrs.src ?? node.attrs.url ?? '')
        const name = String(node.attrs.title ?? node.attrs.filename ?? 'file')
        return place('file', url, name)
      }
      case 'video': return place('video', String(node.attrs.src ?? ''))
      case 'audio': return place('audio', String(node.attrs.src ?? ''))
      case 'face': case 'emoji': return `[${node.attrs.name ?? '表情'}]`
      default: return visit(node.children)
    }
  }).join('')
  const text = visit(elements).replace(/<quote>\s*<\/quote>/g, '').replace(/\n{3,}/g, '\n\n').trim()
  return { text, media, mentionsSelf, replyTo }
}

/**
 * The quoted message recovered from a Satori `quote` object — for platforms that hand the
 * quote over as data instead of text. koishi's QQ group events are that case: the adapter
 * decodes `msg_elements[0]` into `message.quote = { member, elements }` and never sets an
 * id, while `@satorijs/protocol` encodes only the quote's `id` and `content` into the
 * rendered string — so the text keeps an empty `<quote></quote>` and the referenced body is
 * thrown away unless it is read from here. Groups also get no reply id at all (the official
 * API has no "fetch a group message by id"), so this object is the only way to see what was
 * replied to. Private/C2C quotes do carry `content` and render on their own; the caller
 * skips this then.
 */
export function renderQuote(quote: any, sink?: MediaSpecSink): { senderName: string, text: string, media: MediaRef[] } | undefined {
  if (!quote || typeof quote !== 'object') return undefined
  const media: MediaRef[] = []
  const place = (kind: MediaRef['kind'], url: string, name?: string, mime?: string): string => {
    media.push(kind === 'file' ? { kind, url, name } : kind === 'image' ? { kind, url, mime } : { kind, url })
    const id = sink?.({ source: 'quote', kind, url, name, mime })
    return id ? mediaTag(id, kind, name) : kind === 'image' ? '[图片]' : `[文件 ${name ?? ''}]`
  }
  const visit = (nodes: unknown): string => (Array.isArray(nodes) ? nodes : []).map((node: any) => {
    switch (node?.type) {
      case 'text': return String(node.attrs?.content ?? '')
      case 'at': return `@${node.attrs?.name ?? node.attrs?.id ?? ''}`
      case 'br': return ' '
      case 'img': case 'image': {
        const url = String(node.attrs?.src ?? node.attrs?.url ?? '')
        return url ? place('image', url, undefined, node.attrs?.type) : '[图片]'
      }
      case 'file': {
        const name = String(node.attrs?.title ?? node.attrs?.filename ?? 'file')
        const url = String(node.attrs?.src ?? node.attrs?.url ?? '')
        return url ? place('file', url, name) : `[文件 ${name}]`
      }
      case 'video': return '[视频]'
      case 'audio': return '[语音]'
      case 'face': case 'emoji': return `[${node.attrs?.name ?? '表情'}]`
      default: return visit(node.children)
    }
  }).join('')
  // someone else's text on its way into our own markup: it must never close the tag we wrap it in.
  // Truncated like renderElements() does, because the full body is still in the history anyway.
  const text = visit(quote.elements).replace(/<\/?quote>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const senderName = String(quote.member?.nick ?? quote.member?.name ?? quote.user?.name ?? quote.user?.nick ?? '').trim()
  if (!text && !senderName && !media.length) return undefined
  return { senderName, text, media }
}

/** koishi + @satorijs/adapter-qq (official bot). */
export class QQOfficialClient extends SatoriClient {
  protected eventsUrl(): string { return this.cfg.endpoint.replace(/^http/, 'ws') + '/v1/events' }
  protected identify(ws: WebSocket): void { ws.send(JSON.stringify({ op: 3, body: { token: this.cfg.token } })) }

  protected handleFrame(frame: any): void {
    if (frame.op === 4) {
      const login = frame.body.logins?.find((l: any) => l.platform === 'qq' && l.adapter === 'qq')
      // A reconnect while koishi/the adapter is still coming up delivers a login
      // entry without an id. Overwriting selfId with it silently disables every
      // @-mention (renderElements can no longer tell our id apart), so only ever
      // replace it with a real one.
      const id = login?.self_id ?? login?.user?.id
      if (id) this.selfId = String(id)
      if (this.selfId) this.onSelfId?.(this.selfId)
      else this.log('warn', 'qq ready without a login id: @-mentions stay disabled')
      this.onStatus?.('ready')
      this.log('info', `qq ready selfId=${this.selfId}`)
      return
    }
    if (frame.op !== 0) return
    const body = frame.body
    this.nextSeq(body.sn)
    if (body.type !== 'message-created' || body.platform !== 'qq' || !body.message) return
    const conv = `qq:${String(body.channel?.id ?? body.guild?.id)}`
    const messageId = String(body.message.id)
    const ts = body.timestamp ?? Date.now()
    const senderName = String(body.member?.nick ?? body.user?.name ?? body.user?.id)
    const sink = this.mediaSink({ conv, messageId, ts, senderName })
    const elements = h.parse(body.message.content ?? '')
    const { text: rendered, media, mentionsSelf, replyTo } = renderElements(elements, [this.selfId], sink)
    // The body of a reply. koishi renders it into `content` for private chats, but a QQ group
    // reply arrives as `<quote></quote>正文` with the referenced body only in `message.quote`
    // (see renderQuote) — fold it back in so the agent reads the same `<quote>…</quote>` prefix
    // it sees everywhere else.
    const quote = renderQuote(body.message.quote, sink)
    const inner = quote ? `${quote.senderName ? `${quote.senderName}：` : ''}${quote.text}`.trim() : ''
    const text = inner && !rendered.includes('<quote>') ? `<quote>${inner}</quote> ${rendered}`.trimEnd() : rendered
    const direct = body.channel?.type === 1 || !body.guild
    const quoteId = body.message.quote?.id ?? replyTo
    // The adapter turns the event's `author.member_role` into `member.roles`; group
    // messages normally carry it, so the sender's own role costs us nothing.
    const senderRole = direct ? undefined : memberRole(body.member?.roles?.[0]?.id)
    // A merged forward is not an element on this platform: QQ renders the whole bundle into one
    // text element (with its attachments as `[附件]` lines). Parsing it back into items lets the
    // official side be handled exactly like the userbot side (preview, get_forward, media ids) —
    // and the pictures inside become viewable at all, which they never were.
    const dump = parseForwardDump(text)
    this.emit({
      platform: 'qq', conv, channelId: String(body.channel?.id ?? body.guild?.id), direct,
      title: body.guild?.name ?? body.channel?.name ?? '',
      id: messageId, senderId: String(body.user?.id), senderName, senderAvatar: body.user?.avatar,
      ts, text: dump ? forwardPlaceholder(1, dump.title, bundlePreview(dump.items)) : text, raw: body.message, replyTo: quoteId,
      mentionsSelf, self: String(body.user?.id) === this.selfId, senderRole, media, quotedMedia: quote?.media.length ? quote.media : undefined,
      forwards: dump ? [{ id: '1', title: dump.title, snapshot: dump.items }] : [],
    })
  }

  /** QQ official: markdown + keyboard buttons are native; passive reply id keeps the send within quota. */
  async send(channelId: string, direct: boolean, parts: OutboundPart[], replyTo?: InboundMessage): Promise<string[]> {
    // A markdown message must never travel with a quote: QQ then attaches the
    // body's plain-text rendition twice and clients that draw it show the
    // sentence twice. See markdownDropsQuote in qq.ts for the measurements.
    // An @ element has to be folded into the body as QQ's own markup, because the
    // adapter's group encoder drops the element (see foldMentions in qq.ts).
    const outgoing = markdownDropsQuote(foldMentions(parts))
    const content = outgoing.map((part) => {
      switch (part.type) {
        case 'text': return h.escape(part.text ?? '')
        case 'markdown': return `<qq:markdown>${h.escape(part.text ?? '')}</qq:markdown>`
        case 'image': return h('img', { src: part.src }).toString()
        case 'file': return h('file', { src: part.src, title: part.name }).toString()
        case 'quote': return h.quote(part.messageId!).toString()
        case 'buttons': return (part.buttons ?? []).map((row) => `<button-group>${row.map((b) => h('button', {
          type: b.kind === 'link' ? 'link' : b.kind === 'input' ? 'input' : 'action',
          ...(b.kind === 'link' ? { href: b.data } : b.kind === 'input' ? { text: b.data } : { id: b.data }),
        }, b.label).toString()).join('')}</button-group>`).join('')
        default: return ''
      }
    }).join('')
    const result = await this.ext<{ id: string }[]>('send', {
      selfId: this.selfId, channelId, direct, content,
      replyTo: replyTo && replyTo.channelId === channelId && Date.now() - replyTo.ts < 4.5 * 60_000 ? { messageId: replyTo.id } : undefined,
    })
    return result.map((r) => r.id)
  }

  /** Group events carry only the opaque openid, so the real group name is fetched here. */
  guildName(channelId: string): Promise<{ name: string }> {
    return this.ext<{ name: string }>('guild', { selfId: this.selfId, channelId })
  }

  /**
   * One member's group role, for the messages whose event did not carry
   * `member_role` (the official API answers `/v2/groups/…/members/…`).
   */
  memberRole(channelId: string, userId: string): Promise<{ role: string, name?: string }> {
    return this.ext<{ role: string, name?: string }>('member', { selfId: this.selfId, channelId, userId })
  }
}

/** crossgram satori-exporter (userbot, the admin's own QQ account). */
export class CrossgramClient extends SatoriClient {
  /** userbot account sends prefix; the account is shared with a human. */
  static readonly PREFIX = '🤖 '
  /** Effective prefix; the bot refreshes it from settings before each send. */
  sendPrefix = CrossgramClient.PREFIX

  protected eventsUrl(): string { return this.cfg.endpoint.replace(/^http/, 'ws') + '/v1/events' }
  protected identify(ws: WebSocket): void { ws.send(JSON.stringify({ op: 3, body: { token: this.cfg.token } })) }

  protected handleFrame(frame: any): void {
    if (frame.op === 4) {
      // The exporter registers this userbot under its numeric QQ id, so the Satori
      // login id doubles as the self id: senders, mentions, and `@me` detection all
      // stay in the numeric space the events below use.
      const login = frame.body?.logins?.find((l: any) => l.platform === 'qq')
      const id = login?.self_id ?? login?.user?.id
      if (id) { this.selfId = String(id); this.loginId = this.selfId; this.onSelfId?.(this.selfId) }
      else this.log('warn', 'cg ready without a login id: @-mentions stay disabled')
      this.onStatus?.('ready')
      this.log('info', `cg ready selfId=${this.selfId} login=${this.loginId}`)
      return
    }
    if (frame.op !== 0) return
    const body = frame.body
    this.nextSeq(body.sn)
    if (body.type !== 'orange-message') return
    // `_payload` bypasses the Satori wire's snake_case key transform, so the
    // rendered shape below keeps its original camelCase fields.
    const { conversation, message, outgoing } = body._payload ?? {}
    if (!conversation || !message) return
    const media: MediaRef[] = []
    const forwards: InboundMessage['forwards'] = []
    let mentionsSelf = false
    const sink = this.mediaSink({
      conv: `cg:${conversation.id}`, messageId: String(message.id), ts: message.timestamp,
      senderName: String(message.senderTitle || message.senderName || message.senderId),
    })
    const text = (message.parts as any[]).map((part) => {
      if (part.type === 'text') {
        // Rewrite mention-of-self spans to a fixed marker: the raw span is the bot's own
        // nickname (e.g. "@sudo rm -rf /") and reads like a shell command to the model.
        let text: string = part.text
        for (const e of [...(part.entities ?? [])].sort((x: any, y: any) => y.offset - x.offset) as any[]) {
          if (e.type !== 'mention' || e.userId !== this.selfId) continue
          mentionsSelf = true
          text = text.slice(0, e.offset) + '[@我]' + text.slice(e.offset + e.length)
        }
        return text
      }
      if (part.type === 'media') {
        const kind = part.kind === 'image' ? 'image' : 'file'
        media.push({ kind, url: part.url, name: part.name, mime: part.mimeType })
        const id = sink?.({ source: 'message', kind, url: part.url, name: part.name, mime: part.mimeType, size: part.size, width: part.width, height: part.height })
        return id ? mediaTag(id, kind, part.name) : kind === 'image' ? `[图片#${media.length}]` : `[文件#${media.length} ${part.name ?? ''}]`
      }
      if (part.type === 'sticker') return `[表情 ${part.title ?? ''}]`
      if (part.type === 'card') return `[卡片 ${part.title}${part.url ? ' ' + part.url : ''}]`
      if (part.type === 'forward') {
        forwards.push({ id: part.id, title: part.title, preview: part.preview, locator: part.locator })
        return forwardPlaceholder(forwards.length, part.title, part.preview)
      }
      return ''
    }).join('').trim()
    const direct = conversation.kind === 'direct'
    this.emit({
      platform: 'cg', conv: `cg:${conversation.id}`, channelId: String(conversation.id), direct, title: conversation.title ?? '',
      id: String(message.id), senderId: String(message.senderId), senderName: String(message.senderTitle || message.senderName || message.senderId), senderAvatar: message.senderAvatar,
      ts: message.timestamp, text, raw: message, replyTo: message.replyToId, mentionsSelf,
      self: !!outgoing || message.senderId === this.selfId, media, forwards,
    })
  }

  async send(channelId: string, _direct: boolean, parts: OutboundPart[], _replyTo?: InboundMessage): Promise<string[]> {
    let prefixed = false
    const content = parts.map((part) => {
      switch (part.type) {
        case 'text': case 'markdown': {
          // userbot has no markdown: degrade to plain text
          const text = (prefixed ? '' : this.sendPrefix) + (part.type === 'markdown' ? stripMarkdown(part.text ?? '') : (part.text ?? ''))
          prefixed = true
          return h.escape(text)
        }
        case 'image': return h('img', { src: part.src }).toString()
        case 'file': return h('file', { src: part.src, title: part.name }).toString()
        // the nickname rides along: the exporter turns this into `@名字` plus a mention entity,
        // and without it the half a client falls back to is the raw uid
        case 'at': return h.at(part.userId!, part.name ? { name: part.name } : {}).toString()
        case 'quote': return h.quote(part.messageId!).toString()
        case 'sticker': return stickerElement(part.sticker!).toString()
        case 'buttons': return h.escape((part.buttons ?? []).flat().filter((b) => b.kind === 'link').map((b) => `\n${b.label}: ${b.data}`).join(''))
        default: return ''
      }
    }).join('')
    // A sticker-only reply stays a bare 表情: prepending the 🤖 marker would turn
    // it into a text message with a picture attached, which is not the same thing.
    const finalContent = prefixed || !this.sendPrefix || parts.some((p) => p.type === 'sticker') ? content : h.escape(this.sendPrefix.trim()) + content
    const result = await this.api<{ id: string }[]>('message.create', { channel_id: channelId, content: finalContent })
    return (result ?? []).map((r) => r.id)
  }

  /** Withdraw our own messages (the platform only accepts this briefly after the send). */
  recall(channelId: string, messageIds: string[]): Promise<{ recalled: string[], failed?: { id: string, error: string }[] }> {
    return this.ext('message.recall', { channelId, messageIds })
  }

  react(channelId: string, messageId: string, keys: string[]): Promise<unknown> {
    return this.ext('reaction.set', { channelId, messageId, reactionKeys: keys })
  }

  /**
   * The privileged members (owner + administrators) of a userbot group. The Satori
   * `guild.member.get` that satori-exporter offers drops the role, so a role has to
   * come from the orange-ext bridge route, which reads the platform member list.
   */
  memberRoles(channelId: string): Promise<{ id: string, role: string, name?: string }[]> {
    return this.ext<{ members: { id: string, role: string, name?: string }[], total?: number }>('member.roles', { channelId })
      .then((r) => r?.members ?? [])
  }

  forward(locator: unknown): Promise<any[]> { return this.ext('forward.get', { locator }) }
  history(channelId: string, limit: number, before?: string): Promise<any[]> { return this.ext('history.list', { channelId, limit, before }) }
  message(channelId: string, messageId: string): Promise<any> { return this.ext('message.get', { channelId, messageId }) }
}

/**
 * The Satori element that makes crossgram send a *native* 表情 instead of a
 * picture: an `<img>` carrying the five sticker attributes `stickerMetadata()`
 * in satori-exporter reads back. All five must be present (an empty pack id is
 * how a pack-less favorite is expressed), otherwise the exporter rejects the
 * metadata as incomplete and the message goes out as a plain image.
 */
function stickerElement(sticker: OutboundSticker): any {
  return h('img', {
    'data-crossgram-sticker-provider': sticker.providerId,
    'data-crossgram-sticker-id': sticker.stickerId,
    'data-crossgram-sticker-pack': sticker.packId ?? '',
    'data-crossgram-sticker-name': sticker.name,
    'data-crossgram-sticker-reference': sticker.reference,
  })
}

/** Markdown -> plain text for platforms without markdown (keep link targets). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => label === url ? url : `${label} ${url}`)
    .replace(/^#{1,6}\s+/gm, '')
}
