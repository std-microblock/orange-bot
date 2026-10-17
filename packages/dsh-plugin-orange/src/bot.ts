/**
 * The orange engine: ingests both platforms, records everything, decides when
 * to wake the chat agent (direct triggers + batched classifier), and owns the
 * per-conversation dsh sessions plus background task sessions.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import type { Config, GroupSettings, OwnProject } from './config.ts'
import { Store, type MediaRow, type StoredMessage } from './store.ts'
import { CrossgramClient, QQOfficialClient, memberRole, stripMarkdown, type InboundMessage, type MediaEntry, type MediaRef, type MediaSpec, type MediaSpecSink, type MemberRole, type OutboundPart, type PlatformKey } from './satori.ts'
import { bundlePreview, forwardPlaceholder, mediaTag, parseForwardDump, type BundleForward, type BundleItem, type BundleMedia } from './media.ts'
import { PAIR_CONFIRM, PAIR_MIN_CHARS, PAIR_WINDOW_MS, groupAvatar, pairText, senderMatch } from './pairing.ts'
import { chat, parseJsonLoose } from './llm.ts'
import type { MentionCandidate } from './mentions.ts'
import { humanizeAtMarkup } from './qq.ts'
import { screenTrigger } from './privacy.ts'
import { CHAT_PERSONA, TASK_PERSONA, classifierSystem, projectBrief, projectLine, stickerPrompt, stylePolishSystem, stylePrompt } from './prompts.ts'
import { acceptStyled, pickSubStyles } from './style.ts'
import { REPEAT_MIN_CHARS, REPEAT_WINDOW_MS, answerKey, repeatSendError, sameAnswer, sendUnknownError } from './repeat.ts'
import { MessageSegments, StickerService, segmentWantsSticker } from './stickers.ts'
import type { MessageSegment } from './stickers.ts'
import { createLog, type Log } from './log.ts'

export type TriggerKind = 'mention' | 'command' | 'reply' | 'direct' | 'classifier' | 'task' | 'admin'

/**
 * Who somebody is, as far as the bot can tell: the bot's own administrator list
 * (the master, global), the group's owner (群主) and its administrators (群管理员),
 * and everybody else. The group roles are identity only — they are shown to the
 * agent and in the panel, they do not widen what the bot (or the agent) may do.
 */
export type Rank = 'bot' | 'owner' | 'administrator' | 'member'

export const RANK_LABEL: Record<Rank, string> = { bot: '机器人管理员', owner: '群主', administrator: '群管理员', member: '普通成员' }

/** How long a userbot group's role roster is trusted before it is fetched again. */
const ROLE_TTL_MS = 6 * 3600_000

/** One reason to wake the chat agent; a burst of these is merged into one event. */
interface PendingWake {
  trigger: TriggerKind
  message?: InboundMessage
  reason?: string
  ts: number
}

interface ConvState {
  /** last seq handed to classifier or agent */
  classifiedSeq: number
  /** last seq delivered to the agent session */
  deliveredSeq: number
  timer?: NodeJS.Timeout
  lastBotTs: number
  proactive: number[]
  /** a classifier call is in flight; classifyAgain re-runs once it settles */
  classifying?: boolean
  classifyAgain?: boolean
  /** latest inbound message (for passive replies) */
  lastInbound?: InboundMessage
  /** triggers waiting to be merged into one agent turn */
  pending: PendingWake[]
  /** the drain loop owns pending wakes for this conversation */
  waking?: boolean
  /** newest cross-group event already shown to this conversation's agent */
  eventSeq: number
  /** physical messages that already woke this conversation (see twinTrigger) */
  triggered: { ts: number, text: string, at: number }[]
  /** the bot's current burst of messages here, for the automatic 表情 (see noteSend) */
  segments?: MessageSegments
}

interface ChatSession {
  sessionId: string
  conv: string
  createdTs: number
  lastTs: number
  busy: boolean
}

export interface Turn {
  conv: string
  trigger: TriggerKind
  triggerMessage?: InboundMessage
  responseIds: number[]
}

/** Triggers landing inside this window become one agent turn (default, overridable in settings). */
const WAKE_MERGE_MS = 2_000
/** The twin side's copy of one message still counts as the same trigger this long after it. */
const TWIN_TRIGGER_MS = 2_000
/** Deliver anyway after waiting this long for a busy agent, rather than sitting on a reply. */
const WAKE_IDLE_MAX_MS = 10 * 60_000
/** Most messages one event carries; a longer backlog keeps the newest and notes the gap. */
const WAKE_MAX_MESSAGES = 240
/** Messages of a merged forward shown in its placeholder before the agent expands it. */
const FORWARD_PREVIEW = 3
/** Messages one merged-forward expansion renders. */
const FORWARD_MAX_LINES = 200
/** How deep nested merged forwards are followed. */
const FORWARD_MAX_DEPTH = 3
/** One bundle fetched from crossgram is reused this long while several of its attachments are resolved. */
const FORWARD_CACHE_MS = 30_000
/** How far apart the two platforms' copies of one forwarded message can be. */
const TWIN_FORWARD_MS = 120_000

/**
 * How to get the url of one attachment inside a merged forward again — what `media.plan` holds.
 * `locator` is the *message's* (top-level) bundle and `path`/`position` say where inside it the
 * attachment sits: the platform only ever gives out a locator for a whole bundle, so walking from
 * the top is the one address that stays valid for nested bundles too. An attachment of the
 * *official* rendering has no locator at all (that platform never hands us one), so its plan carries
 * what it takes to find the same attachment on the userbot side instead: the bundle title, where it
 * sat, when the message arrived and who sent it.
 */
interface ForwardPlan {
  kind: 'locator' | 'dump'
  path: string
  position: number
  name?: string
  /** The title of the message's *outermost* bundle — what the twin conversation's copy is matched by. */
  forward: string
  ts: number
  senderName: string
  locator?: unknown
}

function parsePlan(plan?: string): ForwardPlan | undefined {
  if (!plan) return undefined
  try {
    const parsed = JSON.parse(plan) as ForwardPlan
    return parsed && typeof parsed.position === 'number' && typeof parsed.path === 'string' ? parsed : undefined
  } catch { return undefined }
}

/** Whether two attachments are the same file, told apart only by the platform's own name for it. */
function sameMedia(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}
const DIRECT_HINT = '需要回应（只是表态就用 react，不发"收到"；凡是结论要靠翻源码/手册/日志、跑命令或脚本、上网查资料、算数值或按帧模拟才能拿到的，一律 start_task 交给后台，别在这个 session 里自己查）'
const CLASSIFIER_HINT = '只有把握很大时才说话，否则调用 no_reply'

const AI_COMMAND = /^\s*[\/／]ai(?:\s+|$)/i
const WHITE_COMMAND = /^\s*[\/／]ai\.white\s+(add|remove|list)\s*(.*)$/i
const RESET_COMMAND = /^\s*[\/／]ai(?:\.|\s+)reset\b\s*(.*)$/i
const DRY_COMMAND = /^\s*[\/／]ai\.dry\s+(on|off)\s*(.*)$/i
const BG_COMMAND = /^\s*[\/／]ai\.bg(?![\w.])/i

/** A duration in words: 45秒 / 12分钟 / 3小时5分 / 2天4小时. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}秒`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min}分钟`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h}小时${min % 60}分` : `${h}小时`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}天${h % 24}小时` : `${d}天`
}

/**
 * The official bot renders "reply to <msg>" as a literal `<quote>…</quote>`
 * prefix inside the text, which pushes `/ai` off the front of the string and
 * defeats every `^`-anchored command regex. Strip those prefixes first.
 */
export function commandText(text: string): string {
  let out = text
  for (;;) {
    const match = /^\s*<quote\b[^>]*>[\s\S]*?<\/quote>/.exec(out)
    if (!match) return out.trimStart()
    out = out.slice(match[0].length)
  }
}

/**
 * The `trigger=` attribute of a wake. A lone trigger keeps the original wording;
 * a merged batch lists every trigger that landed inside it.
 */
function describeTriggers(batch: PendingWake[], tag?: (m: InboundMessage) => string): string {
  if (batch.length === 1) {
    const b = batch[0]
    if (b.trigger === 'classifier') return `classifier（旁听判断可能相关：${b.reason}）——${CLASSIFIER_HINT}`
    // The panel's 唤醒 button carries a reason; it is the only thing that tells the
    // agent why it was woken without a message, so it has to survive into the event.
    const note = b.reason ? `，面板说明：${b.reason}` : ''
    return `direct（${b.trigger}${b.message ? `，来自 ${b.message.senderName}${tag?.(b.message) ? `（${tag(b.message)}）` : ''}` : ''}${note}）——${DIRECT_HINT}`
  }
  const parts: string[] = []
  const direct = batch.filter((b) => b.trigger !== 'classifier')
  if (direct.length) {
    const what = [...new Set(direct.map((b) => b.message ? `${b.trigger} 来自 ${b.message.senderName}${tag?.(b.message) ? `（${tag(b.message)}）` : ''}` : b.trigger))]
    parts.push(`direct（${what.join('、')}，共 ${direct.length} 次）——${DIRECT_HINT}`)
  }
  for (const b of batch.filter((b) => b.trigger === 'classifier')) parts.push(`classifier（旁听判断可能相关：${b.reason}）——${CLASSIFIER_HINT}`)
  return parts.join('；')
}

export class OrangeBot {
  readonly store: Store
  readonly qq: QQOfficialClient
  readonly cg: CrossgramClient
  private conv = new Map<string, ConvState>()
  private sessions = new Map<string, ChatSession>()
  /** sessionId -> current turn being served, for send_message routing */
  readonly turns = new Map<string, Turn>()
  readonly status: Record<PlatformKey, string> = { qq: 'connecting', cg: 'connecting' }
  private errorTimes: number[] = []
  /** Messages we sent on cg, by text, to tell bot vs human on the shared account. */
  private pendingSelfTexts: { conv: string, text: string, sticker?: boolean, label?: string, ts: number }[] = []
  /**
   * Answers already on their way in each conversation, for the repeat guard: pushed when the send
   * starts, not when it is confirmed, because a call that fails after the platform took the message
   * leaves no row to compare against (see repeat.ts).
   */
  private recentAnswers = new Map<string, { at: number, key: string }[]>()
  /** Merged-forward bundles already fetched, so resolving one message's attachments costs one call. */
  private forwardCache = new Map<string, { at: number, items: Promise<BundleItem[]> }>()
  readonly mediaDir: string
  readonly log: Log
  /** The 表情 pool: imports from the QQ account, descriptions, and sending. */
  readonly stickers: StickerService
  listeners = new Set<(event: any) => void>()
  /** Set on shutdown: in-flight handlers must not touch the closed database. */
  private stopped = false

  constructor(readonly ctx: Context, readonly config: Config) {
    this.store = new Store(config.dataDir)
    this.log = createLog(config.dataDir)
    for (const id of this.store.get<string[]>('botTwinIds', [])) this.botTwinIds.add(id)
    this.mediaDir = '/var/cache/orange-tmp/media'
    this.stickers = new StickerService(this)
    const log = (level: 'info' | 'warn', msg: string) => level === 'info' ? this.log.info(msg) : this.log.warn(msg)
    this.qq = new QQOfficialClient('qq', config.koishi, log)
    this.cg = new CrossgramClient('cg', config.crossgram, log)
    for (const client of [this.qq, this.cg]) {
      // Self id survives reconnects and restarts: a READY frame may arrive without
      // it, and without it we cannot recognize @-mentions at all.
      client.selfId = this.store.get(`selfId:${client.platform}`, '')
      client.onSelfId = (id) => this.store.set(`selfId:${client.platform}`, id)
    }
    for (const client of [this.qq, this.cg]) {
      client.onStatus = (s) => { this.status[client.platform] = s; this.broadcast({ type: 'status', status: this.status }) }
      client.on((m) => { void this.onMessage(m).catch((e) => this.reportError(`ingest ${m.conv}`, e)) })
      // Every attachment either platform renders gets one id and is printed as `[图片 #12]`
      // right where it sat (see media.ts) — the agent then asks for that id, not for a
      // position inside a message or a path into a forward.
      client.onMedia = (entry) => this.mediaId(entry)
    }
  }

  start(): void {
    this.qq.start(); this.cg.start()
    void this.refreshKoishiCommands()
    this.koishiTimer = setInterval(() => void this.refreshKoishiCommands(), 10 * 60_000)
    // Earlier builds paired groups on "same text, same moment", which random pairs
    // real traffic constantly: re-derive the links and the official group names from
    // what is actually stored before trusting anything.
    setTimeout(() => void this.repairPeers().catch((e) => this.reportError('peer repair', e)), 5_000)
    this.nameTimer = setInterval(() => void this.refreshGroupNames().catch(() => {}), 30 * 60_000)
    // Group roles: the official bot gets them with every group message, the userbot
    // side has to be asked, so re-check each served userbot group now and then.
    setTimeout(() => this.refreshAllRoles(), 90_000)
    this.roleTimer = setInterval(() => this.refreshAllRoles(true), ROLE_TTL_MS)
  }

  private roleTimer?: NodeJS.Timeout

  private nameTimer?: NodeJS.Timeout

  private koishiTimer?: NodeJS.Timeout
  private koishiCommands = { prefixes: ['/', '!', '！'], names: new Set<string>() }

  private async refreshKoishiCommands(): Promise<void> {
    try {
      const r = await this.qq.ext<{ prefixes: string[], commands: string[] }>('commands', {})
      this.koishiCommands = { prefixes: r.prefixes.filter(Boolean), names: new Set(r.commands.map((c) => c.toLowerCase())) }
    } catch (error) {
      this.log.warn(`koishi command list: ${(error as Error).message}`)
    }
  }

  /** Whether koishi will handle this message as one of its own commands. */
  isKoishiCommand(raw: string): boolean {
    const text = commandText(raw)
    let body = text.replace(/@\S+\s*/g, '').trim()
    const prefix = this.koishiCommands.prefixes.find((p) => body.startsWith(p))
    if (prefix) body = body.slice(prefix.length)
    else if (!text.includes('@橘波特')) return false // without prefix koishi only reacts when mentioned
    const word = body.split(/\s+/)[0]?.toLowerCase()
    if (!word) return false
    if (this.koishiCommands.names.has(word)) return true
    // "/xxx" with an unknown name addressed to the bot: koishi says "unknown command", not ours either
    return !!prefix && /^[a-z0-9._-]+$/i.test(word) && word !== 'ai' && !word.startsWith('ai.')
  }

  /**
   * A stored message that belongs to koishi, not to the agent: only the official side
   * runs koishi, and `/ai` stays ours. They still belong in the history the agent reads,
   * but they must never become a reason to wake it — a member calling "@bot /ac" is
   * asking the plugin, and koishi answers it.
   */
  private koishiHandled(m: StoredMessage): boolean {
    return m.conv.startsWith('qq:') && !AI_COMMAND.test(commandText(m.text)) && this.isKoishiCommand(m.text)
  }
  stop(): void {
    this.stopped = true
    clearInterval(this.koishiTimer)
    clearInterval(this.nameTimer)
    clearInterval(this.roleTimer)
    this.qq.stop(); this.cg.stop()
    for (const state of this.conv.values()) {
      clearTimeout(state.timer)
      state.segments?.stop()
    }
    this.store.close()
  }

  broadcast(event: any): void { for (const l of this.listeners) { try { l(event) } catch {} } }

  isAdmin(platform: PlatformKey, userId: string): boolean {
    return this.config.admins.includes(`${platform}:${userId}`)
  }

  client(platform: PlatformKey) { return platform === 'qq' ? this.qq : this.cg }

  // -------------------------------------------------------------- identities --
  /**
   * Three kinds of people matter in a group, and only the first one has any
   * authority over the bot: the 机器人管理员 (config.admins, the master, global),
   * the 群主 and the 群管理员 the platform reports for this group. Group roles are
   * recorded and shown — to the agent, the panel and the logs — but they grant
   * nothing: cross-group reads, settings and whitelisting stay admin-only.
   */
  rank(conv: string, userId: string): Rank {
    const info = this.store.conversation(conv)
    const platform = (info?.platform ?? conv.slice(0, 2)) as PlatformKey
    if (this.isAdmin(platform, userId)) return 'bot'
    if (info?.direct) return 'member'
    const role = this.roleCache.get(roleKey(conv, userId)) ?? this.store.memberRole(conv, userId)
    return role === 'owner' || role === 'administrator' ? role : 'member'
  }

  /** The `{…}` marker a message line carries, empty for an ordinary member. */
  tag(conv: string, userId: string): string {
    const rank = this.rank(conv, userId)
    return rank === 'member' ? '' : RANK_LABEL[rank]
  }

  /** Everyone with a recognizable identity in this conversation, for prompts, tools and the panel. */
  privileged(conv: string): { key: string, name: string, role: Rank }[] {
    const out: { key: string, name: string, role: Rank }[] = []
    for (const key of this.config.admins) out.push({ key, name: this.display(key), role: 'bot' })
    for (const row of this.store.memberRoles(conv, true)) {
      const key = `${conv.slice(0, 2)}:${row.userId}`
      out.push({ key, name: this.display(key), role: row.role === 'owner' ? 'owner' : 'administrator' })
    }
    return out
  }

  /** "张三(cg:…B1sy)": a name when we know one, plus enough of the key to act on. */
  display(key: string): string {
    const id = key.slice(3)
    const raw = this.store.user(key)?.name?.trim()
    // the platforms hand us the odd literal "undefined" as a nickname
    const name = raw && raw !== id && !/^(undefined|null|nan)$/i.test(raw) ? raw : ''
    const short = `${key.slice(0, 2)}:${id.length > 10 ? `…${id.slice(-8)}` : id}`
    return name ? `${name}(${short})` : short
  }

  /** The platform one conversation speaks. */
  platformOf(conv: string): PlatformKey {
    return (this.store.conversation(conv)?.platform ?? conv.slice(0, 2)) as PlatformKey
  }

  /**
   * The bot's own accounts, in one platform's id space: what a message may never @, and what a
   * `@橘波特` in the agent's text has to be *recognized* as — so it stays the literal text it is
   * instead of pinging the bot (or being reported as an @ nobody knows).
   */
  isSelfId(platform: PlatformKey, userId: string): boolean {
    if (!userId) return false
    if (this.store.get(`selfId:${platform}`, '') === userId) return true
    if ((platform === 'cg' ? this.cg : this.qq).selfId === userId) return true
    // the official bot's account, seen through the userbot's view of the same group
    return platform === 'cg' && this.botTwinIds.has(userId)
  }

  /**
   * The directory a mention the agent writes is resolved against: everybody whose messages it has
   * read here (a line prints the tail of an id next to a nickname), everybody the platform named
   * as 群主/群管, and the bot's own accounts last — marked, so `@橘波特` is recognized but never
   * turns into an @ of itself. Newest speaker first, which is what a nickname collision resolves by.
   */
  mentionCandidates(conv: string): MentionCandidate[] {
    const platform = this.platformOf(conv)
    const out: MentionCandidate[] = []
    const seen = new Set<string>()
    const add = (id: string, name: string | undefined, self: boolean) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      const named = String(name ?? '').trim()
      out.push({ id, ...(named && named !== id ? { name: named } : {}), ...(self ? { self: true } : {}) })
    }
    for (const row of this.store.senders(conv, 500)) add(row.id, row.name, this.isSelfId(platform, row.id))
    for (const row of this.store.memberRoles(conv)) add(row.userId, this.store.user(`${conv.slice(0, 2)}:${row.userId}`)?.name, this.isSelfId(platform, row.userId))
    for (const id of [this.qq.selfId, this.cg.selfId, ...this.botTwinIds]) add(id, '橘波特', true)
    return out
  }

  /**
   * The @ a reply owes its target: a message that visibly replies to somebody (`say` with
   * `quote=#seq`) also mentions them, so the person actually gets told. The passive reply every
   * agent turn carries (`msg_id`, used for the quota) is invisible in the group — @-ing on that
   * would ping somebody on every single message the bot says, so it does not count here.
   *
   * Skipped when there is nobody to tell: a private chat, a reply to the bot's own message, and
   * the account the bot itself sends as (the userbot shares the admin's account).
   */
  replyMention(conv: string, quoted?: StoredMessage): OutboundPart | undefined {
    if (!quoted) return undefined
    if (this.store.conversation(conv)?.direct) return undefined
    if (quoted.fromBot || quoted.self) return undefined
    if (this.isSelfId(this.platformOf(conv), quoted.senderId)) return undefined
    const name = String(quoted.senderName ?? '').trim()
    return { type: 'at', userId: quoted.senderId, ...(name && name !== quoted.senderId ? { name } : {}) }
  }

  /** What a mention prints as in stored text and the panel: the nickname, else the id tail. */
  atLabel(conv: string, id: string): string {
    const name = this.store.user(`${this.platformOf(conv)}:${id}`)?.name?.trim()
    return name && name !== id && !/^(undefined|null|nan)$/i.test(name) ? name : id.slice(-8)
  }

  /** conv+user -> last role we stored, so a repeat message costs no write. */
  private roleCache = new Map<string, string>()
  /** When a userbot group's roster was last fetched, and whether it worked. */
  private roleFetched = new Map<string, { at: number, ok: boolean }>()
  /** Same for the per-member fallback lookup on the official side. */
  private qqRoleFetched = new Map<string, { at: number, ok: boolean }>()
  /** undefined = not tried yet, false = the official app may not query members at all. */
  private qqRoleApi?: boolean

  /** Whether this group is one the bot actually serves (whitelisted, or a twin of one). */
  private servesGroup(conv: string): boolean {
    const group = this.store.group(conv)
    if (group.whitelisted) return true
    const peer = group.peer
    return !!peer && this.store.group(peer).whitelisted
  }

  private rememberRole(conv: string, userId: string, role: MemberRole, source: string): void {
    const key = roleKey(conv, userId)
    if (this.roleCache.get(key) === role) return
    this.roleCache.set(key, role)
    this.store.setMemberRole(conv, userId, role, source)
    if (role !== 'member') {
      this.log.info(`role ${conv}: ${this.display(`${conv.slice(0, 2)}:${userId}`)} 是${RANK_LABEL[role]}`)
      this.broadcast({ type: 'settings' })
    }
  }

  /**
   * Learn the sender's group role from one message. The official bot puts
   * `member_role` into every group message, so this is free there; when an event
   * does not carry it, ask the adapter once. A QQ app is often not allowed to query
   * members at all (11253 应用无接口访问权限) — then asking is pointless, so this
   * remembers that and relies on the events from then on.
   */
  private learnRole(m: InboundMessage): void {
    if (m.senderRole) { this.rememberRole(m.conv, m.senderId, m.senderRole, m.platform); return }
    if (m.platform === 'cg') { this.refreshRoles(m.conv); return }
    if (this.qqRoleApi === false || this.stopped) return
    if (this.store.memberRole(m.conv, m.senderId)) return
    const seen = this.qqRoleFetched.get(m.conv)
    if (seen && Date.now() - seen.at < (seen.ok ? 60_000 : 6 * 3600_000)) return
    const channelId = this.store.conversation(m.conv)?.channelId ?? m.conv.slice(3)
    void this.qq.memberRole(channelId, m.senderId).then((info) => {
      this.qqRoleApi = true
      this.qqRoleFetched.set(m.conv, { at: Date.now(), ok: true })
      const role = memberRole(info?.role)
      if (role) this.rememberRole(m.conv, m.senderId, role, 'qq')
    }).catch((error) => {
      const detail = (error as Error).message
      if (/11253|无接口访问权限/.test(detail)) {
        this.qqRoleApi = false
        this.log.info(`member role lookup unavailable (${detail.slice(0, 160)}): roles now come from the message events only`)
        return
      }
      this.qqRoleFetched.set(m.conv, { at: Date.now(), ok: false })
      this.log.warn(`member role ${m.conv}: ${detail}`)
    })
  }

  /**
   * The userbot never says a sender's role in the message itself, but it can list a
   * group's members: fetch the roster of a served group, keep the owner and the
   * administrators, and re-check at most every ROLE_TTL_MS so a promotion, demotion
   * or ownership handover shows up instead of lingering.
   */
  private refreshRoles(conv: string): void {
    if (!conv.startsWith('cg:') || !this.servesGroup(conv)) return
    const seen = this.roleFetched.get(conv)
    if (seen && Date.now() - seen.at < (seen.ok ? ROLE_TTL_MS : 10 * 60_000)) return
    this.roleFetched.set(conv, { at: Date.now(), ok: false })
    void this.fetchRoles(conv).catch((error) => this.log.warn(`roles ${conv}: ${(error as Error).message}`))
  }

  private async fetchRoles(conv: string): Promise<void> {
    const channelId = this.store.conversation(conv)?.channelId ?? conv.slice(3)
    const members = await this.cg.memberRoles(channelId)
    const rows = members.map((m) => ({ id: String(m.id), role: memberRole(m.role) ?? 'member' })).filter((m) => m.id)
    for (const key of [...this.roleCache.keys()]) if (key.startsWith(`${conv} `)) this.roleCache.delete(key)
    this.store.replaceMemberRoles(conv, rows, 'cg')
    this.roleFetched.set(conv, { at: Date.now(), ok: true })
    const named = rows.filter((r) => r.role !== 'member').map((r) => `${RANK_LABEL[r.role as Rank]} ${this.display(`${conv.slice(0, 2)}:${r.id}`)}`)
    this.log.info(`roles ${conv}: ${named.join('、') || '没有群主/群管理员'}`)
    this.broadcast({ type: 'settings' })
  }

  /** Re-read the roster of every served userbot group (`force` re-checks the TTL). */
  refreshAllRoles(force = false): void {
    for (const row of this.store.conversations()) {
      if (row.direct || !row.key.startsWith('cg:') || !this.servesGroup(row.key)) continue
      if (force) this.roleFetched.delete(row.key)
      this.refreshRoles(row.key)
    }
  }

  private state(conv: string): ConvState {
    let s = this.conv.get(conv)
    if (!s) {
      const last = this.store.recent(conv, 1)[0]
      const lastBot = this.store.db.prepare('SELECT MAX(ts) ts FROM messages WHERE conv = ? AND from_bot = 1').get(conv) as { ts: number | null }
      s = { classifiedSeq: last?.seq ?? 0, deliveredSeq: last?.seq ?? 0, lastBotTs: lastBot?.ts ?? 0, proactive: [], pending: [], eventSeq: this.store.maxEventId(), triggered: [] }
      this.conv.set(conv, s)
    }
    return s
  }

  // ---------------------------------------------------------------- ingest --
  /**
   * Whether this conversation's content may be recorded. The userbot account is
   * shared with the admin, so the raw stream carries his private chats and every
   * group the account sits in; only what the bot actually serves is kept:
   * whitelisted groups (and their twin row on the other platform, needed for
   * pairing), plus the admin's own private chat with the bot.
   */
  servesConversation(m: InboundMessage): boolean {
    if (m.direct) {
      const partner = m.channelId || m.conv.slice(3)
      if (this.isAdmin(m.platform, partner)) return true
      if (m.platform === 'cg' && this.botTwinIds.has(partner)) return true
      return this.store.get(`selfId:${m.platform}`, '') === partner
    }
    const group = this.store.group(m.conv)
    if (group.whitelisted) return true
    const peer = group.peer
    return !!peer && this.store.group(peer).whitelisted
  }

  async onMessage(m: InboundMessage): Promise<void> {
    if (this.stopped) return
    // Official-bot group events carry the openid as the channel name, and C2C events
    // carry no nickname at all: neither is a title, they would show up as a hex id.
    const named = m.senderName && m.senderName !== m.senderId ? m.senderName : ''
    const observed = m.title && m.title !== m.channelId ? m.title : m.direct ? named : ''
    const served = this.servesConversation(m)
    if (m.direct && !served) return // somebody else's private chat: no row, no text, nothing
    this.store.upsertConversation({ key: m.conv, platform: m.platform, channelId: m.channelId, title: observed, titleSrc: m.direct ? 'dm' : m.platform, direct: m.direct })
    if (m.platform === 'qq' && !m.direct && !observed) void this.refreshGroupName(m.conv).catch(() => {})
    if (!served) {
      // A group we do not serve is tracked by name only, so the panel can offer it for
      // whitelisting; none of its content is stored. Admin commands still run here —
      // that is how a group gets whitelisted in the first place.
      this.store.touchConversation(m.conv, m.ts)
      if (this.isAdmin(m.platform, m.senderId)) await this.handleCommand(m, true, commandText(m.text))
      return
    }
    // userbot account is shared with the admin: tell our own sends apart from his.
    // A text send matches by text; a bare 表情 has no text of its own, so it is
    // recognized by the placeholder the feed renders for a sticker/picture.
    let fromBot = false
    /** Set when the echo is a 表情 of ours: its label replaces the feed's placeholder. */
    let selfLabel: string | undefined
    if (m.self) {
      const n = normalize(m.text)
      const idx = this.pendingSelfTexts.findIndex((p) => p.conv === m.conv && Date.now() - p.ts < 60_000
        && (p.text ? n.includes(normalize(p.text).slice(0, 40)) : !!p.sticker && /^\[(?:表情|图片|视频)/.test(m.text.trim())))
      if (idx >= 0) {
        fromBot = true
        selfLabel = this.pendingSelfTexts[idx].label
        this.pendingSelfTexts.splice(idx, 1)
      }
      if (m.platform === 'qq') fromBot = true
    }
    if (m.text.startsWith(CrossgramClient.PREFIX.trim()) && m.self) fromBot = true
    // the official bot's own messages echoed through the userbot's view of the same group
    if (m.platform === 'cg' && !m.self && this.botTwinIds.has(m.senderId)) fromBot = true
    const enriched = await this.enrichText(m)
    // Our own 表情, remembered with its identity: `[表情#1]` says nothing about
    // which one it was, and both the panel and the agent read this text.
    const text = selfLabel ?? enriched
    /** Command matching must look past the QQ quote prefix. */
    const cmdText = commandText(m.text)
    // A cg message identical to something the official bot just sent in the paired group is its echo.
    if (m.platform === 'cg' && !m.self && !fromBot) {
      const peer = this.store.group(m.conv).peer
      const twin = peer ? this.store.findSimilar(peer, text, m.ts, 30_000) : undefined
      if (twin?.fromBot) {
        fromBot = true
        this.botTwinIds.add(m.senderId)
        this.store.set('botTwinIds', [...this.botTwinIds])
      }
    }
    // initialize cursors before this message lands so it counts as new
    this.state(m.conv)
    const stored = this.store.insertMessage({
      conv: m.conv, id: m.id, senderId: m.senderId, senderName: m.self && fromBot ? '橘波特' : m.senderName, ts: m.ts,
      text, raw: JSON.stringify({ media: m.media, forwards: m.forwards }), replyTo: m.replyTo,
      self: m.self, mentionsSelf: m.mentionsSelf, fromBot,
    })
    if (!stored) return
    if (!m.self || m.platform === 'cg') this.store.touchUser(`${m.platform}:${m.senderId}`, m.senderName, m.senderAvatar)
    if (!m.direct && !fromBot) this.learnRole(m)
    this.ensureConvAvatar(m)
    this.broadcast({ type: 'message', message: stored, title: m.title })
    // One physical group can be visible through both bots. Pair them via `peer`;
    // the official-bot side owns the group, the userbot side only records history.
    // The bots' own messages count as evidence too: the same send shows up on both
    // sides, which is exactly what a link needs.
    this.learnPeer(m, stored)
    // The official API does not always hand a group reply's referenced body over (see borrowQuote):
    // the twin side of the same group knows it, so complete the row before anyone reads it.
    void this.borrowQuote(m.conv, stored).catch((e) => this.reportError(`quote backfill ${m.conv}`, e))
    if (fromBot) return
    // Our own userbot sends echo back through the official bot as plain group messages.
    if (m.platform === 'qq' && m.text.startsWith(CrossgramClient.PREFIX.trim())) { this.store.markFromBot(m.conv, m.id); return }
    const state = this.state(m.conv)
    state.lastInbound = m

    const owner = this.ownerOf(m.conv)
    if (owner !== m.conv) {
      // history-only side: the official-bot twin owns the triggers of this group.
      // The official QQ API never says *which* message a group reply quotes — it only
      // forwards the quoted body, and the adapter drops even that object's id — so
      // "replied to 橘波特" is invisible on the owner side: only here, where crossgram
      // carries the real reply id, can it be seen. Hand it over.
      const quoted = m.replyTo ? this.store.byId(m.conv, m.replyTo) : undefined
      if (quoted?.fromBot && served) {
        void this.forwardReply(owner, m).catch((e) => this.reportError(`reply forward ${owner}`, e))
        return
      }
      if (m.mentionsSelf || AI_COMMAND.test(cmdText)) this.log.info(`no trigger ${m.conv}: peer ${owner} owns this group`)
      return
    }

    // ---- commands ---------------------------------------------------------
    const isAdmin = this.isAdmin(m.platform, m.senderId)
    if (await this.handleCommand(m, isAdmin, cmdText)) return
    // messages koishi answers itself ("@bot /ac", "/抽奖", …) are not for the agent
    if (m.platform === 'qq' && !AI_COMMAND.test(cmdText) && this.isKoishiCommand(cmdText)) return

    // ---- trigger decision -------------------------------------------------
    const settings = this.store.group(m.conv)
    const repliedToBot = m.replyTo ? this.store.byId(m.conv, m.replyTo)?.fromBot === true : false
    let trigger: TriggerKind | undefined
    if (m.direct) {
      // private chats: admin only (on the userbot the admin's own outgoing DMs need /ai)
      if (isAdmin && !m.self) trigger = 'direct'
      else if (isAdmin && m.self && AI_COMMAND.test(cmdText)) trigger = 'command'
    } else if (AI_COMMAND.test(cmdText) && (settings.whitelisted || isAdmin)) {
      trigger = 'command'
    } else if (m.mentionsSelf && settings.whitelisted && (m.platform === 'qq' || this.store.settings().cgMentionTrigger)) {
      // userbot @ is the admin's own account, so only the official bot treats @ as a trigger
      trigger = 'mention'
    } else if (repliedToBot && settings.whitelisted && !m.self) {
      trigger = 'reply'
    }
    if (trigger) {
      clearTimeout(state.timer)
      state.timer = undefined
      this.wake(m.conv, trigger, m)
      return
    }
    if (!m.direct && settings.whitelisted && settings.listen && !m.self) this.scheduleClassify(m.conv)
    else if (AI_COMMAND.test(cmdText) || m.mentionsSelf || repliedToBot) {
      // someone addressed the bot and nothing happened: say why, so this is diagnosable
      this.log.info(`no trigger ${m.conv} white=${settings.whitelisted} listen=${settings.listen} self=${m.self} mention=${m.mentionsSelf} reply=${repliedToBot}`)
    }
  }

  /** userbot-side user ids of the official bot account (learned from echoes of our qq sends). */
  readonly botTwinIds = new Set<string>()

  /** Conversation avatar: the userbot side is a public URL by its own group number; DMs use the peer's avatar. */
  private ensureConvAvatar(m: InboundMessage): void {
    if (m.direct) {
      if (!m.self && m.senderAvatar && this.store.conversation(m.conv)?.avatar !== m.senderAvatar) this.store.setConversationAvatar(m.conv, m.senderAvatar)
      return
    }
    // Official-bot groups have no group number of their own; their avatar is derived
    // from the *correct* twin when the panel asks for it (store.convAvatar), never
    // stored, so a bad pairing cannot leave a wrong picture behind.
    if (m.platform !== 'cg' || !/^\d+$/.test(m.channelId)) return
    const url = groupAvatar(m.channelId)
    if (this.store.conversation(m.conv)?.avatar !== url) this.store.setConversationAvatar(m.conv, url)
  }

  /**
   * The conversation that handles triggers for this physical group: the official bot,
   * because its messages carry the passive-reply ids. But the official bot only sees
   * what the platform pushes to it — some groups never grant it the full stream — so
   * a twin that has gone quiet hands the triggers back to the userbot side, which
   * always sees the group.
   */
  ownerOf(conv: string): string {
    const peer = this.store.group(conv).peer
    if (!peer) return conv
    if (conv.startsWith('qq:') || !peer.startsWith('qq:')) return conv
    const last = this.store.recent(peer, 1)[0]?.ts ?? 0
    return Date.now() - last < 6 * 3600_000 ? peer : conv
  }

  // ---- peer learning -------------------------------------------------------
  /**
   * Evidence that two conversations are the same physical group: distinct matching
   * messages, each normalized to the words actually typed, seen seconds apart from
   * the same person on both platforms. Kept per conversation and per candidate, so a
   * well-supported pair always beats a coincidental one.
   */
  private peerHits = new Map<string, Map<string, Set<string>>>()
  private guildFetched = new Map<string, { at: number, ok: boolean }>()

  private vote(conv: string, other: string, text: string): void {
    let byOther = this.peerHits.get(conv)
    if (!byOther) this.peerHits.set(conv, byOther = new Map())
    let texts = byOther.get(other)
    if (!texts) {
      if (byOther.size >= 64) return // a group cannot have more plausible twins than this
      byOther.set(other, texts = new Set())
    }
    if (texts.size < 40) texts.add(text)
  }

  private hits(conv: string, other: string): number {
    return this.peerHits.get(conv)?.get(other)?.size ?? 0
  }

  private learnPeer(m: InboundMessage, stored: StoredMessage): void {
    if (m.direct) return
    const ntext = pairText(stored.text)
    if (ntext.length < PAIR_MIN_CHARS) return
    const twins = this.store.twins(ntext, stored.seq, stored.ts, PAIR_WINDOW_MS, m.platform === 'qq' ? 'cg:' : 'qq:')
    for (const twin of twins) {
      if (!senderMatch(twin.senderName, stored.senderName)) continue
      this.vote(m.conv, twin.conv, ntext)
      this.vote(twin.conv, m.conv, ntext)
      this.reconcile(m.conv)
    }
  }

  /** Re-point a conversation at its best-supported twin; weak or conflicting links lose. */
  private reconcile(conv: string): void {
    const byOther = this.peerHits.get(conv)
    if (!byOther) return
    let best = ''
    let bestN = 0
    for (const [other, texts] of byOther) if (texts.size > bestN) { best = other; bestN = texts.size }
    if (!best || bestN < PAIR_CONFIRM) return
    const current = this.store.group(conv).peer
    if (current === best) return
    // an established twin with equal or better evidence keeps the link
    if (current && (byOther.get(current)?.size ?? 0) >= bestN) return
    // do not steal a twin that has stronger evidence for somebody else
    const rival = this.store.group(best).peer
    if (rival && rival !== conv && this.hits(best, rival) > bestN) return
    this.linkPeers(conv, best, bestN)
  }

  /** Link the two views of one group, releasing whatever either side was paired with before. */
  private linkPeers(a: string, b: string, evidence = 0): void {
    const qq = a.startsWith('qq:') ? a : b
    const cg = qq === a ? b : a
    if (!qq.startsWith('qq:') || !cg.startsWith('cg:')) return
    for (const stale of [this.store.group(qq).peer, this.store.group(cg).peer]) {
      if (!stale || stale === a || stale === b) continue
      const back = this.store.group(stale).peer
      this.store.clearPeer(stale)
      // release the far end too when it still points at the twin we just dropped
      if (back && back !== a && back !== b && this.store.group(back).peer === stale) this.store.clearPeer(back)
      this.log.info(`unpaired ${stale} (superseded by ${qq} <-> ${cg})`)
    }
    this.store.linkPeers(qq, cg)
    this.log.info(`paired ${qq} <-> ${cg} (evidence ${evidence})`)
    this.broadcast({ type: 'settings' })
  }

  // ---- official group names ------------------------------------------------
  /**
   * QQ group events carry only an opaque openid — no name, no avatar. Ask the
   * adapter for the real group name, so an official-only group is never shown (or
   * named) after whatever unrelated group it was once mis-paired with.
   */
  async refreshGroupName(conv: string, force = false): Promise<void> {
    if (!conv.startsWith('qq:')) return
    const row = this.store.conversation(conv)
    if (row?.direct) return
    const named = !!row?.title && row.titleSrc === 'qq'
    const seen = this.guildFetched.get(conv)
    if (!force && seen) {
      // failed lookups retry soon, an unnamed group every few hours, a known name daily (renames)
      const wait = seen.ok ? (named ? 24 * 3600_000 : 6 * 3600_000) : 10 * 60_000
      if (Date.now() - seen.at < wait) return
    }
    this.guildFetched.set(conv, { at: Date.now(), ok: true })
    try {
      const info = await this.qq.guildName(row?.channelId ?? conv.slice(3))
      if (info?.name) {
        this.store.setConversationTitle(conv, info.name, 'qq')
        this.broadcast({ type: 'settings' })
        this.linkByName(conv)
      }
    } catch (error) {
      this.guildFetched.set(conv, { at: Date.now(), ok: false })
      this.log.warn(`group name ${conv}: ${(error as Error).message}`)
    }
  }

  private async refreshGroupNames(): Promise<void> {
    const keys = new Set(this.store.conversations().filter((c) => c.platform === 'qq' && !c.direct).map((c) => c.key))
    // groups that were configured but never spoke still deserve their real name
    for (const key of Object.keys(this.store.settings().groups)) if (key.startsWith('qq:')) keys.add(key)
    for (const key of keys) await this.refreshGroupName(key)
    for (const key of keys) this.linkByName(key)
  }

  /**
   * The group's own name is a second, independent signal: when the official API name
   * and a userbot title are identical — and unique — the two views are the same group
   * even if there was too little matching traffic. Only ever used for a side that
   * message evidence left unpaired, so it cannot break a supported link.
   */
  private nameTwin(a: string, b: string): boolean {
    const qq = a.startsWith('qq:') ? a : b
    const cg = qq === a ? b : a
    const name = this.store.conversation(qq)?.title?.trim()
    if (!name || name.length < 5) return false // short names ("粥吧") are not distinctive enough
    if (this.store.conversation(cg)?.title?.trim() !== name) return false
    const matches = this.store.conversations().filter((c) => c.platform === 'cg' && !c.direct && c.title.trim() === name)
    return matches.length === 1 && matches[0].key === cg
  }

  private linkByName(qqConv: string): void {
    if (this.store.group(qqConv).peer) return
    // the name is unique across userbot groups: find the one that claims it
    const name = this.store.conversation(qqConv)?.title?.trim()
    if (!name || name.length < 5) return
    const cg = this.store.conversations().find((c) => c.platform === 'cg' && !c.direct && c.title.trim() === name)?.key
    if (!cg || !this.nameTwin(qqConv, cg)) return
    if (this.store.group(cg).peer === qqConv) return
    const rival = this.store.group(cg).peer
    if (rival && this.hits(cg, rival) >= PAIR_CONFIRM) return
    this.linkPeers(qqConv, cg, this.hits(qqConv, cg))
    this.log.info(`paired ${qqConv} <-> ${cg} by name "${name}"`)
  }

  // ---- repair --------------------------------------------------------------
  /**
   * Recompute every peer link from stored traffic and throw away what the old
   * "same text, same moment" heuristic invented: it paired unrelated groups (two
   * images 3s apart were enough), and each false pair copied the other group's name
   * and avatar onto the row, so both the panel and the trigger routing were wrong.
   */
  async repairPeers(): Promise<void> {
    const rows = this.store.db.prepare(`SELECT m.conv, m.sender_name, m.ts, m.seq, m.ntext FROM messages m JOIN conversations c ON c.key = m.conv
      WHERE c.direct = 0 AND m.ntext IS NOT NULL AND LENGTH(m.ntext) >= ? ORDER BY m.ts`).all(PAIR_MIN_CHARS) as any[]
    const byText = new Map<string, { conv: string, sender: string, ts: number }[]>()
    for (const r of rows) {
      let list = byText.get(r.ntext)
      if (!list) byText.set(r.ntext, list = [])
      list.push({ conv: r.conv, sender: r.sender_name ?? '', ts: r.ts })
    }
    for (const [ntext, list] of byText) {
      if (list.length > 400) continue // spam repeats carry no pairing information
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]
          const b = list[j]
          if (b.ts - a.ts > PAIR_WINDOW_MS) break
          if (a.conv.slice(0, 2) === b.conv.slice(0, 2)) continue
          if (!senderMatch(a.sender, b.sender)) continue
          this.vote(a.conv, b.conv, ntext)
          this.vote(b.conv, a.conv, ntext)
        }
      }
    }
    // Official group names and avatars were copied from arbitrary twins by the old
    // code: forget them *before* auditing links, so a stale borrowed name cannot
    // pretend to confirm the very pairing it came from. Names fetched from the
    // adapter ('qq') are kept.
    for (const c of this.store.conversations()) {
      if (c.direct) {
        // DMs: an openid is not a name — drop it, the panel resolves the real one
        if (c.title === c.channelId || /^[0-9A-F]{32}$/i.test(c.title)) this.store.setConversationTitle(c.key, '', 'dm')
        continue
      }
      if (c.platform !== 'qq') {
        // userbot groups know their own group number, hence their own avatar
        if (/^\d+$/.test(c.channelId) && c.avatar !== groupAvatar(c.channelId)) this.store.setConversationAvatar(c.key, groupAvatar(c.channelId))
        continue
      }
      if (c.title && c.titleSrc !== 'qq') this.store.setConversationTitle(c.key, '', '')
      if (c.avatar) this.store.clearConversationAvatar(c.key)
    }
    const before = Object.entries(this.store.settings().groups).filter(([, g]) => g?.peer).length
    for (const conv of [...this.peerHits.keys()]) this.reconcile(conv)
    // Audit every link: keep what traffic or an exact group name supports (and make
    // it symmetric again), drop the rest — they were guesses, not evidence.
    for (const [conv, settings] of Object.entries(this.store.settings().groups)) {
      const peer = settings?.peer
      if (!peer) continue
      if (this.hits(conv, peer) < PAIR_CONFIRM && !this.nameTwin(conv, peer)) {
        this.store.clearPeer(conv)
        this.log.info(`unpaired ${conv}: no evidence it is ${peer}`)
        continue
      }
      if (this.store.group(peer).peer === conv) continue
      const qq = conv.startsWith('qq:') ? conv : peer
      const cg = qq === conv ? peer : conv
      if (qq.startsWith('qq:') && cg.startsWith('cg:') && this.store.group(peer).peer !== conv) {
        this.store.linkPeers(qq, cg)
        this.log.info(`repaired one-way link ${qq} <-> ${cg}`)
      } else {
        this.store.clearPeer(conv)
      }
    }
    const after = Object.entries(this.store.settings().groups).filter(([, g]) => g?.peer).length
    this.log.info(`peer repair: ${before} links before, ${after} after`)
    this.broadcast({ type: 'settings' })
    await this.refreshGroupNames()
  }
  /**
   * Replace a merged forward in the stored text with a `<forward id="1" …>` block: the first few
   * messages as a preview, the total count, and how to pull the rest. Both platforms arrive here —
   * the userbot side hands over a locator the bundle can be asked for again, the official side
   * only the text it rendered the bundle into (parseForwardDump). Every attachment inside gets its
   * id while rendering, so the first picture is one `view_image(#12)` away; on the official side
   * that is the only way to reach it at all, because the urls in that rendering are not ours to
   * download (see resolveMedia).
   */
  private async enrichText(m: InboundMessage): Promise<string> {
    let text = m.text
    if (!m.forwards.length) return text
    const sink = this.mediaSinkFor({ conv: m.conv, messageId: m.id, ts: m.ts, senderName: m.senderName })
    for (const [index, fwd] of m.forwards.entries()) {
      try {
        const block = await this.renderForward(fwd, String(index + 1), fwd.title, {
          depth: 1, limit: FORWARD_PREVIEW, hint: true, sink, root: fwd.title, rootLocator: fwd.locator,
          conv: m.conv, messageId: m.id, ts: m.ts, senderName: m.senderName,
        })
        // a function replacement: the block is other people's text, `$&`/`$1` in it are literal
        text = text.replace(new RegExp(`\\[合并转发#${index + 1}[^\\]]*\\]`), () => block)
      } catch (error) {
        this.log.warn(`forward expand failed: ${(error as Error).message}`)
      }
    }
    return text
  }

  /**
   * Render one merged-forward bundle as `<forward id="<path>" title=… count=…>`. `limit` is how
   * many of its messages are shown (a preview, or all of them when a tool pulls it). Attachments
   * are numbered by their position inside *this* bundle and printed as `[图片 #id]`; the position
   * is counted over every attachment of the bundle — including the ones a preview hides — so the
   * number an id belongs to never moves when the rest is pulled afterwards. Nested bundles get
   * their own path (`"1.2"` = the second one inside forward 1) and their own attachment ids.
   */
  private async renderForward(ref: { locator?: unknown, snapshot?: BundleItem[] }, path: string, title: string, opts: {
    depth: number, limit: number, hint?: boolean, sink?: MediaSpecSink,
    conv: string, messageId: string, ts: number, senderName: string,
    /** The top-level bundle of the message: its title and locator identify it in the twin conversation. */
    root: string,
    rootLocator?: unknown,
  }): Promise<string> {
    const items = await this.bundleItems(ref)
    const lines: string[] = []
    let nested = 0
    let position = 0
    for (const [index, item] of items.entries()) {
      const show = index < opts.limit
      const parts: string[] = []
      const blocks: string[] = []
      for (const p of item.parts as any[]) {
        if (p.type === 'text') { if (show) parts.push(p.text); continue }
        if (p.type === 'media') {
          const at = position++
          if (!show) continue
          parts.push(this.forwardMediaTag(p as BundleMedia, this.forwardPlan(opts.rootLocator, path, at, p as BundleMedia, {
            forward: opts.root, ts: opts.ts, senderName: opts.senderName,
          }), opts.sink))
          continue
        }
        if (p.type === 'forward') {
          nested += 1
          if (!show) continue
          blocks.push(opts.depth < FORWARD_MAX_DEPTH
            ? await this.renderForward(p, `${path}.${nested}`, String(p.title ?? ''), { ...opts, depth: opts.depth + 1, limit: FORWARD_PREVIEW, hint: true }).catch(() => `[合并转发 ${p.title}]`)
            : `[合并转发 ${p.title}]`)
          continue
        }
        if (show && p.title) parts.push(`[${p.title}]`)
      }
      if (!show) continue
      if (parts.length || !blocks.length) lines.push(`${item.senderName || '?'}: ${parts.join('')}`)
      else lines.push(`${item.senderName || '?'}:`)
      lines.push(...blocks)
    }
    const shown = Math.min(items.length, opts.limit)
    if (items.length > shown) {
      lines.push(opts.hint
        ? `…（共 ${items.length} 条，只列了前 ${shown} 条，完整内容用 get_forward(index="${path}") 取）`
        : `…（共 ${items.length} 条，这里只展开前 ${shown} 条）`)
    }
    return `<forward id="${path}" title="${title}" count="${items.length}">\n${lines.join('\n')}\n</forward>`
  }

  /**
   * The plan one attachment of a forward is resolved through (see mediaUrl). Built in one place
   * and in one order: the row is keyed by this JSON, so the preview, a later `get_forward` and a
   * legacy `(seq, index)` call all have to produce the very same string to keep the same id.
   */
  private forwardPlan(rootLocator: unknown, path: string, position: number, media: BundleMedia, meta: { forward: string, ts: number, senderName: string }): ForwardPlan {
    return {
      kind: rootLocator === undefined ? 'dump' : 'locator', locator: rootLocator, path, position,
      name: media.name, forward: meta.forward, ts: meta.ts, senderName: meta.senderName,
    }
  }

  /** One attachment of a forward: its id, and the plan that gets its url back when it is looked at. */
  private forwardMediaTag(media: BundleMedia, plan: ForwardPlan, sink?: MediaSpecSink): string {
    const kind = media.kind === 'image' ? 'image' : 'file'
    const id = sink?.({
      source: 'forward', kind, name: media.name, mime: media.mime ?? media.mimeType,
      size: media.size, width: media.width, height: media.height, url: media.url, plan: JSON.stringify(plan),
    })
    if (id) return mediaTag(id, kind, media.name)
    return kind === 'image' ? '[图片]' : `[文件 ${media.name ?? ''}]`
  }

  /** The bundle behind a locator (crossgram) or a snapshot (official dump). */
  private async bundleItems(ref: { locator?: unknown, snapshot?: BundleItem[] }): Promise<BundleItem[]> {
    if (ref.snapshot) return ref.snapshot
    if (ref.locator === undefined) return []
    const key = JSON.stringify(ref.locator)
    const cached = this.forwardCache.get(key)
    if (cached && Date.now() - cached.at < FORWARD_CACHE_MS) return cached.items
    const items = this.cg.forward(ref.locator) as Promise<BundleItem[]>
    this.forwardCache.set(key, { at: Date.now(), items })
    try {
      return await items
    } catch (error) {
      this.forwardCache.delete(key)
      throw error
    }
  }

  /**
   * Every attachment of a bundle *tree*, in the exact order renderForward numbers them
   * (items in order, parts in order, each nested bundle under its own path).
   */
  private async bundleMedia(ref: { locator?: unknown, snapshot?: BundleItem[] }, base = '1'): Promise<{ path: string, position: number, part: BundleMedia }[]> {
    const walk = async (node: { locator?: unknown, snapshot?: BundleItem[] }, path: string, depth: number): Promise<{ path: string, position: number, part: BundleMedia }[]> => {
      const out: { path: string, position: number, part: BundleMedia }[] = []
      let position = 0
      let nested = 0
      for (const item of await this.bundleItems(node)) {
        for (const p of item.parts as any[]) {
          if (p.type === 'media') out.push({ path, position: position++, part: p as BundleMedia })
          else if (p.type === 'forward' && depth < FORWARD_MAX_DEPTH) {
            nested += 1
            out.push(...await walk(p, `${path}.${nested}`, depth + 1))
          }
        }
      }
      return out
    }
    return walk(ref, base, 1)
  }

  /**
   * The merged forwards of a stored message. Rows written before the official side parsed its
   * forwards into items carry only the platform's rendered text — that text is enough to rebuild
   * the structure, so it is parsed here on first use and its attachments become addressable like
   * any other (the rendering itself, and with it every id, happens when the agent pulls it).
   */
  forwardsOf(m: StoredMessage): { id?: string, title: string, locator?: unknown, snapshot?: BundleItem[] }[] {
    const stored = (JSON.parse(m.raw || '{}').forwards ?? []) as { id?: string, title: string, locator?: unknown, snapshot?: BundleItem[] }[]
    if (stored.length) return stored
    const dump = parseForwardDump(m.text)
    if (!dump) return []
    const forwards = [{ id: '1', title: dump.title, snapshot: dump.items }]
    this.store.setForwards(m.seq, forwards)
    return forwards
  }

  /**
   * The attachments of a *stored* message. A message that arrived before this bot parsed forwards
   * (or before anything ever looked at it) has no rows yet, so its forward is rendered once here —
   * which is also what gives its attachments their ids.
   */
  private async storedMedia(m: StoredMessage): Promise<MediaRow[]> {
    const rows = this.store.mediaOf(m.conv, m.id)
    if (rows.length || !this.forwardsOf(m).length) return rows
    await this.forwardContent(m, '1').catch(() => undefined)
    return this.store.mediaOf(m.conv, m.id)
  }

  /**
   * The bundle a dotted path names inside a stored message: `"1"` is its first forward, `"1.2"`
   * the second bundle nested inside that one. Nested bundles are counted in the order they
   * appear in the parent, which is exactly how `renderForward` labels them.
   */
  async forwardAt(m: StoredMessage, path: string): Promise<{ locator?: unknown, snapshot?: BundleItem[], title: string } | undefined> {
    const steps = String(path ?? '').trim().split('.').filter((s) => s.length)
    if (!steps.length || steps.some((s) => !/^\d+$/.test(s))) return undefined
    const top = this.forwardsOf(m)[Number(steps[0]) - 1]
    if (!top) return undefined
    let found: { locator?: unknown, snapshot?: BundleItem[], title: string } = { locator: top.locator, snapshot: top.snapshot, title: String(top.title ?? '') }
    for (const step of steps.slice(1)) {
      const next = (await this.bundleItems(found)).flatMap((item) => (item.parts as any[]).filter((p) => p.type === 'forward'))[Number(step) - 1] as BundleForward | undefined
      if (!next) return undefined
      found = { locator: next.locator, snapshot: next.snapshot, title: String(next.title ?? '') }
    }
    return found.locator !== undefined || found.snapshot ? found : undefined
  }

  /**
   * The whole content of the merged forward at `path`, with every attachment it contains printed
   * as its id. This is what the agent's `get_forward` reads — including for rows stored before
   * forwards were previewed.
   */
  async forwardContent(m: StoredMessage, path: string): Promise<{ text: string, ids: number[] } | undefined> {
    const at = await this.forwardAt(m, path)
    if (!at) return undefined
    const ids: number[] = []
    const sink = (spec: MediaSpec): number => {
      const id = this.mediaId({ ...spec, conv: m.conv, messageId: m.id, ts: m.ts, senderName: m.senderName })
      if (spec.kind === 'image') ids.push(id)
      return id
    }
    const text = await this.renderForward(at, path, at.title, {
      depth: path.split('.').length, limit: FORWARD_MAX_LINES, sink, root: at.title, rootLocator: at.locator,
      conv: m.conv, messageId: m.id, ts: m.ts, senderName: m.senderName,
    })
    return { text, ids }
  }

  private async handleCommand(m: InboundMessage, isAdmin: boolean, text: string): Promise<boolean> {
    const white = WHITE_COMMAND.exec(text)
    if (white) {
      if (!isAdmin) return true
      const [, action, rest] = white
      const ids = rest.trim() ? rest.trim().split(/\s+/).map((id) => id.includes(':') ? id : `${m.platform}:${id}`) : [m.conv]
      if (action === 'list') {
        const list = Object.entries(this.store.settings().groups).filter(([, g]) => g.whitelisted).map(([k]) => `${k} ${this.store.convTitle(k)}`)
        await this.sendText(m.conv, list.join('\n') || '（空）', { replyTo: m, trigger: 'admin' })
      } else {
        for (const id of ids) this.store.updateGroup(id, { whitelisted: action === 'add', listen: action === 'add' ? true : this.store.group(id).listen })
        await this.react(m, 'ok')
        if (m.platform === 'qq') await this.sendText(m.conv, `${action === 'add' ? '加上了' : '移掉了'} ${ids.length} 个`, { replyTo: m, trigger: 'admin' })
      }
      this.broadcast({ type: 'settings' })
      return true
    }
    const dry = DRY_COMMAND.exec(text)
    if (dry) {
      if (!isAdmin) return true
      const ids = dry[2].trim() ? dry[2].trim().split(/\s+/).map((id) => id.includes(':') ? id : `${m.platform}:${id}`) : [m.conv]
      for (const id of ids) this.store.updateGroup(id, { dryRun: dry[1] === 'on' })
      await this.react(m, 'ok')
      this.broadcast({ type: 'settings' })
      return true
    }
    if (BG_COMMAND.test(text)) {
      // in a group: that group's tasks, for anyone there; in private: everything, admin only
      // (the only private chat the bot serves is the admin's own, but check anyway)
      if (m.direct && !isAdmin) return true
      await this.sendText(m.conv, this.backgroundReport(m.direct ? undefined : m.conv), { replyTo: m, trigger: 'admin' })
      return true
    }
    const reset = RESET_COMMAND.exec(text)
    if (reset) {
      if (!isAdmin) return true
      // a trailing @bot (the official bot keeps the mention inside the text) is not part of the target
      const arg = reset[1].replace(/@\S+/g, '').trim()
      const keys = arg ? this.matchConversations(arg) : [m.conv]
      if (!keys.length) {
        await this.sendText(m.conv, `没找到这个会话：${arg}（给 qq:<openid> / cg:<群号>，或者直接给群号）`, { replyTo: m, trigger: 'admin' })
        return true
      }
      const done: string[] = []
      const empty: string[] = []
      for (const key of keys) {
        const had = !!this.store.get(`session:${key}`, undefined)
        await this.resetSession(key)
        const label = `${key} ${this.store.convTitle(key) || ''}`.trim()
        ;(had ? done : empty).push(label)
      }
      const text = [
        done.length ? `重置了 ${done.join('、')}` : '',
        empty.length ? `${empty.join('、')} 本来就没会话` : '',
      ].filter(Boolean).join('；')
      // react alone is invisible on the official-bot side, so always confirm in words
      await this.sendText(m.conv, `${text}（下条消息开新会话）`, { replyTo: m, trigger: 'admin' })
      return true
    }
    return false
  }

  /** Conversations a `/ai.reset <target>` should clear: an explicit key, a channel id, or a group number. */
  private matchConversations(arg: string): string[] {
    const all = this.store.conversations()
    const num = arg.replace(/^(?:qq|cg):/i, '')
    const keys = new Set<string>()
    for (const c of all.filter((c) => c.key === arg || String(c.channelId) === num)) {
      keys.add(c.key)
      // the twin side of the same group is the same conversation for the people in it
      const peer = this.store.group(c.key).peer
      if (peer) keys.add(peer)
    }
    return [...keys].slice(0, 6)
  }

  // ------------------------------------------------------------ classifier --
  private scheduleClassify(conv: string): void {
    const state = this.state(conv)
    if (state.timer) return
    const sinceBot = Date.now() - state.lastBotTs
    // just talked: react fast so answers to our questions are picked up; quiet: batch more
    const delay = sinceBot < 3 * 60_000 ? 3_000 : sinceBot < 15 * 60_000 ? 10_000 : 30_000
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.classify(conv).catch((e) => this.reportError(`classify ${conv}`, e))
    }, delay)
  }

  /**
   * Serialize classifier runs per conversation: a call now retries for a while,
   * so messages arriving meanwhile must not start a second parallel run.
   */
  private async classify(conv: string): Promise<void> {
    const state = this.state(conv)
    if (state.classifying) { state.classifyAgain = true; return }
    state.classifying = true
    try {
      await this.runClassify(conv)
    } finally {
      state.classifying = false
      if (state.classifyAgain) { state.classifyAgain = false; this.scheduleClassify(conv) }
    }
  }

  private async runClassify(conv: string): Promise<void> {
    const settings = this.store.settings()
    if (!settings.classifierEnabled) return
    const state = this.state(conv)
    const fresh = this.store.after(conv, state.classifiedSeq).filter((m) => !m.fromBot)
    if (!fresh.length) return
    // koishi answers its own commands ("@bot /ac", "/抽奖"): calling one is not asking the
    // agent anything. They are neither judged nor shown to the model — the model used to
    // see "someone @s the bot with a command" in the batch and wake on it (10-08, 谢拉格
    // group: /ac woke a turn that could only answer no_reply).
    const judged = fresh.filter((m) => !this.koishiHandled(m))
    const lastSeq = fresh[fresh.length - 1].seq
    if (!judged.length) { state.classifiedSeq = Math.max(state.classifiedSeq, lastSeq); return }
    // quiet groups: wait for at least 3 new messages or 2 minutes before paying for a call,
    // unless the bot spoke recently (answers to its questions must be picked up quickly)
    const sinceBot = Date.now() - state.lastBotTs
    const oldest = judged[0].ts
    if (sinceBot > 30 * 60_000 && judged.length < 3 && Date.now() - oldest < 120_000 && !judged.some((m) => mentionsTopic(m.text, settings))) {
      this.scheduleClassify(conv)
      return
    }
    const group = this.store.group(conv)
    const context = this.store.recent(conv, 50)
    const firstNew = judged[0].seq
    const transcript = context.filter((m) => !this.koishiHandled(m)).map((m) => `${m.seq >= firstNew && !m.fromBot ? '[NEW] ' : ''}${formatLine(m)}`).join('\n')
    const botRecent = context.filter((m) => m.fromBot).slice(-3).map((m) => `- ${m.text.slice(0, 120)}`).join('\n')
    const system = classifierSystem({
      ownProjects: settings.ownProjects.map(projectLine).join('\n'),
      assistTopics: settings.assistTopics.map((p) => `- ${p.name}（${p.aliases.join('/')}，${p.note}）`).join('\n'),
      groupTags: group.tags.join(', '), groupNote: group.note, botRecent,
    })
    const toSeq = lastSeq
    // Transient gateway failures (502/503/429, network hiccups) are retried inside
    // chat(), with the attempt logged instead of reported.
    const classifierLlm = { ...this.config.llm, model: this.config.llm.classifierModel ?? this.config.llm.model }
    const result = await chat(classifierLlm, [{ role: 'system', content: system }, { role: 'user', content: transcript }], {
      json: true,
      maxTokens: 2000,
      onRetry: ({ attempt, error, delayMs }) => this.log.warn(`classifier ${conv} retry ${attempt} in ${delayMs}ms: ${error.message}`),
    })
    // advance only after the model answered, so a call that never succeeded is
    // re-classified together with the next batch instead of losing these messages.
    // A direct trigger may have claimed newer messages while this call was in
    // flight: never rewind past them, or those messages get judged twice.
    state.classifiedSeq = Math.max(state.classifiedSeq, toSeq)
    this.store.recordLlm({ kind: 'classifier', model: classifierLlm.model, input: result.input, cached: result.cached, output: result.output, conv })
    const verdict = parseJsonLoose<{ wake: boolean, kind: string, reason: string, note: string | null, tags?: { user: string, tag: string, on: boolean }[] }>(result.text)
    if (!verdict) { this.log.warn(`classifier unparsable for ${conv}: ${result.text.slice(0, 300)}`); return }
    this.store.recordClassification({ conv, fromSeq: firstNew, toSeq, wake: !!verdict.wake, kind: verdict.kind ?? 'none', reason: verdict.reason ?? '' })
    this.broadcast({ type: 'classification', conv })
    if (verdict.note) this.store.addEvent(conv, verdict.note)
    const platform = conv.slice(0, 2)
    for (const t of verdict.tags ?? []) if (t.tag === 'dev' && t.user) this.store.setUserTag(t.user.includes(':') ? t.user : `${platform}:${t.user}`, 'dev', !!t.on)
    if (!verdict.wake) return
    // rate-limit unsolicited participation
    const hourAgo = Date.now() - 3600_000
    state.proactive = state.proactive.filter((t) => t > hourAgo)
    if (verdict.kind !== 'followup' && state.proactive.length >= settings.proactivePerHour) return
    state.proactive.push(Date.now())
    this.wake(conv, 'classifier', undefined, `${verdict.kind}: ${verdict.reason}`)
  }

  // ----------------------------------------------------------------- agent --
  /**
   * A reply to the bot caught on the history-only twin. The owner side gets the
   * same message stripped of its reply id, so wait for its copy to land (both bots
   * see one physical group, so the timestamp matches) before waking, and then hand
   * the trigger over with the twin's message — wake() tolerates the cross-conv
   * trigger and resolveQuoted() follows the id into the twin's history.
   */
  private async forwardReply(owner: string, m: InboundMessage): Promise<void> {
    const landed = this.store.db.prepare('SELECT 1 FROM messages WHERE conv = ? AND ts = ? LIMIT 1')
    for (let i = 0; i < 15 && !landed.get(owner, m.ts); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    const state = this.state(owner)
    clearTimeout(state.timer)
    state.timer = undefined
    this.log.info(`reply to bot forwarded ${m.conv} -> ${owner} (${m.senderName}: ${m.text.slice(0, 60)})`)
    this.wake(owner, 'reply', m)
  }

  /**
   * Ask for an agent turn on this conversation.
   *
   * Requests are batched instead of handed over one by one: two @s a few seconds
   * apart, or anything that arrives while the previous turn is still running, used
   * to become separate "<event>" messages the harness could only park in its inbox
   * (the GUI's "N 条排队消息"). One drain loop owns a conversation, so every trigger
   * that shows up meanwhile — classifier verdicts included — joins the same batch.
   */
  wake(conv: string, trigger: TriggerKind, message?: InboundMessage, reason?: string): void {
    // Everything a group member sends goes through the screen first: abuse, privacy
    // probing and politics must not reach the agent at all (the admin is exempt —
    // it is his bot, and the screening call would only add latency to his own testing).
    if (message && trigger !== 'classifier' && !this.isAdmin(message.platform, message.senderId)) {
      void this.screenedWake(conv, trigger, message, reason).catch((e) => this.reportError(`screen ${conv}`, e))
      return
    }
    this.wakeNow(conv, trigger, message, reason)
  }

  /** Decide whether to engage at all; a blocked message never enters any session. */
  private async screenedWake(conv: string, trigger: TriggerKind, message: InboundMessage, reason?: string): Promise<void> {
    const verdict = await screenTrigger({ ...this.config.llm, model: this.config.llm.classifierModel ?? this.config.llm.model }, {
      text: message.text,
      senderName: message.senderName,
      replyToBot: message.replyTo ? this.store.byId(message.conv, message.replyTo)?.fromBot === true : false,
    })
    if (!verdict.block) { this.wakeNow(conv, trigger, message, reason); return }
    this.log.info(`screened ${conv} [${verdict.kind}] ${message.senderName}: ${message.text.slice(0, 60)} — ${verdict.reason}`)
    const state = this.state(conv)
    // The message is already stored (this is a whitelisted group): make sure a later
    // event delta cannot hand it to the agent anyway.
    const seq = this.store.byId(message.conv, message.id)?.seq ?? 0
    state.classifiedSeq = Math.max(state.classifiedSeq, seq)
    state.deliveredSeq = Math.max(state.deliveredSeq, seq)
    this.store.recordResponse({
      ts: Date.now(), conv, trigger: 'screened', text: `(screened ${verdict.kind}) ${verdict.reason}｜${message.senderName}: ${message.text.slice(0, 160)}`,
      dryRun: false, delivered: false,
    })
    this.broadcast({ type: 'response', conv })
  }

  private wakeNow(conv: string, trigger: TriggerKind, message?: InboundMessage, reason?: string): void {
    const state = this.state(conv)
    // One physical message reaches us twice: the owner side sees it directly (usually
    // because it @s us) and the twin side sees the same message carrying the real reply id
    // and forwards it (see forwardReply). The two sides can be seconds apart — the runner
    // logs show both orders — which is outside the merge window, so the agent used to get a
    // second turn for a message it had already answered (an extra reply, or a no_reply).
    if (message && this.twinTrigger(state, message)) {
      this.log.info(`duplicate trigger dropped ${conv}: ${message.senderName}: ${message.text.slice(0, 60)}`)
      return
    }
    // claim what this trigger is about to deliver, so the classifier does not judge
    // (and possibly answer) the very same messages again
    state.classifiedSeq = Math.max(state.classifiedSeq, this.store.recent(conv, 1)[0]?.seq ?? 0)
    if (message) this.claimTrigger(state, message)
    state.pending.push({ trigger, message, reason, ts: Date.now() })
    if (!state.waking) void this.drainWakes(conv).catch((e) => this.reportError(`wake ${conv}`, e))
  }

  /**
   * Whether this physical message already woke this conversation from the other side.
   * Both bots stamp one message with the same second-aligned time, so the same timestamp is
   * the twin; a platform whose clock drifts a little still counts when the words typed are
   * identical (their mentions/emoji/media render differently, which utterance() drops).
   */
  private twinTrigger(state: ConvState, message: InboundMessage): boolean {
    const text = utterance(message.text)
    for (const claim of state.triggered) {
      if (claim.ts === message.ts && (!text || !claim.text || text === claim.text)) return true
      if (text && text === claim.text && Math.abs(claim.ts - message.ts) <= TWIN_TRIGGER_MS) return true
    }
    return false
  }

  private claimTrigger(state: ConvState, message: InboundMessage): void {
    const now = Date.now()
    // only recent claims matter: a twin copy that lags longer than this is not a duplicate
    state.triggered = state.triggered.filter((c) => now - c.at < 10 * 60_000).slice(-63)
    state.triggered.push({ ts: message.ts, text: utterance(message.text), at: now })
  }

  /** Merge pending triggers, wait out a running turn, then hand over one event. */
  private async drainWakes(conv: string): Promise<void> {
    const state = this.state(conv)
    state.waking = true
    try {
      while (state.pending.length && !this.stopped) {
        // let a burst finish first: dense messages are one conversation, not N turns
        const merge = this.store.settings().wakeMergeMs ?? WAKE_MERGE_MS
        const wait = merge - (Date.now() - state.pending[0].ts)
        if (wait > 0) await delay(wait)
        const session = await this.ensureSession(conv)
        // delivering mid-turn would only queue behind the running turn: wait for it to
        // end and fold everything that arrives meanwhile into this same event
        if (session.agent?.status === 'running') {
          await Promise.race([Promise.resolve(session.agent.whenIdle?.()).catch(() => {}), delay(WAKE_IDLE_MAX_MS)])
          await delay(250)
          continue
        }
        const batch = state.pending
        state.pending = []
        await this.deliverWake(conv, session, batch)
      }
    } finally {
      state.waking = false
    }
  }

  /** Hand one merged batch of the conversation delta to its chat agent. */
  private async deliverWake(conv: string, session: { record: ChatSession, agent: any, fresh: boolean }, batch: PendingWake[]): Promise<void> {
    const state = this.state(conv)
    // everything since the last delivery, bounded: a long turn can let a flood pile
    // up, and its newest messages matter more than its oldest ones
    const total = this.store.countAfter(conv, state.deliveredSeq)
    const skipped = Math.max(0, total - WAKE_MAX_MESSAGES)
    const delta = skipped ? this.store.recent(conv, WAKE_MAX_MESSAGES) : this.store.after(conv, state.deliveredSeq, WAKE_MAX_MESSAGES)
    state.deliveredSeq = Math.max(state.deliveredSeq, delta.at(-1)?.seq ?? 0)
    state.classifiedSeq = Math.max(state.classifiedSeq, state.deliveredSeq)
    const info = this.store.conversation(conv)
    const group = this.store.group(conv)
    const primary = batch.filter((b) => b.trigger !== 'classifier').at(-1) ?? batch[batch.length - 1]
    const triggers = batch.map((b) => b.message).filter((m): m is InboundMessage => !!m)
    const lines: string[] = []
    lines.push(`<event conv="${conv}" title="${this.store.convTitle(conv) || info?.channelId || ''}" trigger="${describeTriggers(batch, (m) => this.tag(m.conv, m.senderId))}"${group.dryRun ? ' dry_run="true"' : ''}>`)
    // Cross-group dynamics are context, not news: a brand new session gets them all,
    // afterwards only what actually happened somewhere else since the last wake.
    const dynamics = this.store.events(6, conv).filter((e) => Date.now() - e.ts < 48 * 3600_000)
    const unseen = session.fresh ? dynamics : dynamics.filter((e) => e.id > state.eventSeq)
    if (unseen.length) lines.push('其它群动态：\n' + unseen.map((e) => `- [${this.store.convTitle(e.conv) || e.conv}] ${e.text}`).join('\n'))
    state.eventSeq = this.store.maxEventId()
    // fresh session: give it some recent context before the delta
    if (session.fresh) {
      const before = this.store.recent(conv, 20, delta[0]?.seq ?? state.deliveredSeq + 1)
      if (before.length) lines.push('更早的记录：\n' + before.map((m) => formatLine(m, this.tag(m.conv, m.senderId))).join('\n'))
    }
    if (skipped) lines.push(`（更早的 ${skipped} 条消息没有附上，需要时用 chat_history 翻）`)
    const deltaLines = delta.map((m) => this.formatForAgent(m, triggers))
    // A trigger forwarded from the paired twin may not have been stored on this
    // side yet (see forwardReply), so make sure the agent sees what was replied with.
    for (const m of triggers) {
      if (m.conv === conv || delta.some((x) => x.ts === m.ts)) continue
      deltaLines.push(`（同群另一侧）${m.senderName}: ${m.text.replace(/\n/g, '\n  ')} ← 触发`)
    }
    lines.push('新消息：\n' + (deltaLines.length ? deltaLines.join('\n') : '（无新消息）'))
    // a quoted message may predate our history: fetch it so the agent sees what is referred to
    const inlineQuotes = delta.flatMap((m) => quotedBodies(m.text))
    const quotedMedia: MediaRow[] = []
    for (const m of triggers) {
      if (!m.replyTo) continue
      const quoted = await this.resolveQuoted(conv, m.replyTo).catch(() => undefined)
      if (!quoted) continue
      // When the platform hands the quote over as data we already print it inline on the
      // replying message itself (QQ groups — see renderQuote); the twin that forwarded this
      // trigger only resolved the very same quote by id, so saying it again adds nothing.
      if (sameQuote(inlineQuotes, quoted.text)) continue
      lines.push(`被引用的消息：${quoted.senderName}: ${quoted.text}`)
      quotedMedia.push(...quoted.media)
    }
    lines.push('</event>')
    const content: any[] = [{ type: 'text', text: lines.join('\n') }]
    // Inline the pictures this wake came with — the triggering messages' own, the quoted ones, and
    // the ones inside a merged forward, which is the only way the official side ever sees those —
    // so the model looks at them without a tool round-trip. Every one of them also has an id in the
    // text above, so it can be asked for again (or fetched in full) later.
    const inline: MediaRow[] = [...quotedMedia]
    for (const b of batch) {
      if (b.trigger === 'classifier' || !b.message) continue
      // the stored row, not the event: a forward that was never looked at gets its ids here
      const stored = this.store.byId(b.message.conv, b.message.id)
      inline.push(...(stored ? await this.storedMedia(stored) : []))
    }
    const urls: string[] = []
    const seen = new Set<number>()
    for (const row of inline) {
      if (row.kind !== 'image' || seen.has(row.id)) continue
      seen.add(row.id)
      const found = await this.mediaUrl(row).catch(() => undefined)
      if (found && 'url' in found) urls.push(found.url)
      if (urls.length >= 4) break
    }
    for (const url of urls) {
      const image = await this.imageBlock(url).catch(() => undefined)
      if (image) content.push(image)
    }
    this.turns.set(session.record.sessionId, { conv, trigger: primary.trigger, triggerMessage: primary.message, responseIds: [] })
    session.record.lastTs = Date.now()
    // 一律用插入（steer）：这一步已经等到空闲，正常情况下等价于开新一轮；万一还有
    // 残留的 running，也只会插进那一轮的下一个 step，而不是变成 GUI 里的「排队消息」
    session.agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
    this.broadcast({ type: 'wake', conv, trigger: primary.trigger, sessionId: session.record.sessionId })
  }

  /**
   * Fill in a reply's missing quote from whichever side of a paired group knows it.
   *
   * The official API does not always carry the referenced body of a group reply: QQ then sends the
   * message as a plain one (`message_type 0`, no `msg_elements`), so the adapter never builds
   * `message.quote`, the stored text keeps no inline `<quote>` and there is no reply id to resolve
   * — the agent reads `/ai 这里有几个牙齿` with nothing saying *what* it refers to. Measured in one
   * group over five hours: 19 of the 22 replies the admin's own account sent arrived like that, and
   * 4 of the 342 from everyone else. The userbot copy of the very same group always knows the real
   * reply target, and both sides stamp one message with the same second-aligned time, so the two
   * rows are matched by the words typed plus that second (`store.twinRow`) and the row that lost the
   * quote is completed here — stored the way the platform stores its own copies, which is what the
   * wake reads, what `chat_history` shows and what the panel draws.
   */
  private async borrowQuote(conv: string, stored: StoredMessage): Promise<void> {
    const peer = this.store.group(conv).peer
    if (!peer) return
    const twin = this.store.twinRow(peer, stored.text, stored.ts)
    if (stored.replyTo || quotedBodies(stored.text).length) {
      // this copy knows what was replied to; the twin's copy of the same message may have lost it
      if (stored.replyTo && twin && !twin.replyTo && !quotedBodies(twin.text).length) {
        await this.writeQuote(peer, twin, stored.replyTo)
      }
      return
    }
    if (twin?.replyTo) await this.writeQuote(conv, stored, twin.replyTo)
  }

  /**
   * Store a borrowed quote on `row` in the shape the official side stores its own: an inline
   * `<quote>昵称：正文</quote>` prefix (see renderQuote in satori.ts), with the quoted message's
   * attachments registered as this row's `quote` media — that is where the wake's inline pictures
   * come from (see deliverWake), so a quoted photo is handed to the model like any other.
   */
  private async writeQuote(conv: string, row: StoredMessage, replyTo: string): Promise<void> {
    const quoted = await this.resolveQuoted(conv, replyTo)
    if (!quoted) return
    const sink = this.mediaSinkFor({ conv, messageId: row.id, ts: row.ts, senderName: row.senderName })
    let text = quoted.text
    for (const media of quoted.media) {
      const id = sink({ source: 'quote', kind: media.kind, url: media.url, name: media.name, mime: media.mime })
      // the twin's ids are handles too, but this row should own its quote's attachments
      if (id !== media.id) text = text.split(`#${media.id}`).join(`#${id}`)
    }
    // someone else's words on their way into our own markup: never let them close the tag we wrap
    // them in, and clip them the way renderQuote does (the full body stays in the history anyway)
    const inner = `${quoted.senderName ? `${quoted.senderName}：` : ''}${text}`
      .replace(/<\/?quote>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!inner) return
    this.store.setQuote(conv, row.id, `<quote>${inner}</quote> ${row.text}`.trimEnd())
  }

  /** Quoted message from our history, or (userbot side) fetched live, with its attachments. */
  async resolveQuoted(conv: string, id: string): Promise<{ senderName: string, text: string, media: MediaRow[] } | undefined> {
    const peer = this.store.group(conv).peer
    // a trigger forwarded from the twin (see forwardReply) quotes a twin message id
    const local = this.store.byId(conv, id) ?? (peer ? this.store.byId(peer, id) : undefined)
    const cgConv = conv.startsWith('cg:') ? conv : peer
    if (cgConv && (conv.startsWith('cg:') || !local)) {
      const lookupId = conv.startsWith('cg:') ? id : undefined
      if (lookupId) {
        const live = await this.cg.message(cgConv.slice(3), lookupId).catch(() => undefined)
        if (live) {
          // The quoted message may never have been stored (it predates the bot), but its
          // attachments still deserve ids: they are registered here as if it had been.
          const sink = this.mediaSinkFor({
            conv: cgConv, messageId: String(live.id), ts: Number(live.timestamp) || Date.now(),
            senderName: String(live.senderName ?? live.senderTitle ?? ''),
          })
          const ids: number[] = []
          const text = (live.parts as any[]).map((p) => {
            if (p.type === 'text') return p.text
            if (p.type === 'media') {
              const kind = p.kind === 'image' ? 'image' : 'file'
              const mediaId = sink({ source: 'message', kind, url: p.url, name: p.name, mime: p.mimeType, size: p.size, width: p.width, height: p.height })
              ids.push(mediaId)
              return mediaTag(mediaId, kind, p.name)
            }
            return p.title ? `[${p.title}]` : ''
          }).join('')
          return { senderName: String(live.senderName ?? ''), text, media: ids.map((i) => this.store.media(i)).filter((r): r is MediaRow => !!r) }
        }
      }
    }
    if (local) return { senderName: local.senderName, text: local.text, media: this.store.mediaOf(local.conv, local.id) }
    return undefined
  }

  private formatForAgent(m: StoredMessage, triggers: InboundMessage[] = []): string {
    const user = this.store.user(`${m.conv.slice(0, 2)}:${m.senderId}`)
    const tags = user?.tags.length ? ` {${user.tags.join(',')}}` : ''
    const rank = this.tag(m.conv, m.senderId)
    // a trigger forwarded from the twin conv carries the twin's message id
    const hit = triggers.some((t) => t.id === m.id || (t.conv !== m.conv && t.ts === m.ts && t.senderName === m.senderName))
    // koishi's own commands stay in the log the agent reads, but marked: koishi already
    // answered them, so the agent has no reason to (and must not answer twice).
    return `${formatLine(m, rank, this.koishiHandled(m) ? '（koishi 指令，koishi 已回复）' : undefined)}${tags}${hit ? ' ← 触发' : ''}`
  }

  private async ensureSession(conv: string): Promise<{ record: ChatSession, agent: any, fresh: boolean }> {
    const idle = this.store.settings().sessionIdleMs
    let record = this.sessions.get(conv) ?? this.store.get<ChatSession | undefined>(`session:${conv}`, undefined)
    const live = record ? this.ctx.agents.get(record.sessionId as any) : undefined
    if (record && Date.now() - record.lastTs < idle) {
      if (live) { this.sessions.set(conv, record); return { record, agent: live, fresh: false } }
      const resumed = await this.resumeAgent(record.sessionId, 'chat', conv).catch(() => undefined)
      if (resumed) { this.sessions.set(conv, record); return { record, agent: resumed, fresh: false } }
    }
    const title = this.store.convTitle(conv) || conv
    const sessionId = `orange-chat-${conv.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now().toString(36)}`
    const agent = await this.createAgent(sessionId, 'chat', `💬 ${title}`, conv)
    record = { sessionId, conv, createdTs: Date.now(), lastTs: Date.now(), busy: false }
    this.sessions.set(conv, record)
    this.store.set(`session:${conv}`, record)
    return { record, agent, fresh: true }
  }

  async resetSession(conv: string): Promise<void> {
    const record = this.sessions.get(conv) ?? this.store.get<ChatSession | undefined>(`session:${conv}`, undefined)
    if (record) {
      this.ctx.agents.get(record.sessionId as any)?.cancel({ kind: 'user' })
      this.sessions.delete(conv)
      this.store.set(`session:${conv}`, null)
    }
  }

  /** Create a GUI-visible session in the orange workspace with our preset mounted. */
  async createAgent(sessionId: string, role: 'chat' | 'task', title: string, conv: string, admin = false): Promise<any> {
    const ctx = this.ctx as any
    const workspace = await ctx.workspaceRegistry.create(this.config.workspace)
    const presetId = this.config.agentPreset
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: presetId },
      agentOptions: { provider: this.config.llm.provider, model: this.config.llm.agentModel },
      setup: async (agentCtx: any) => {
        await ctx.agentPresets.mount(agentCtx, presetId)
        this.decorate(agentCtx, role, conv)
      },
    })
    await workspace.attachSession(sessionId)
    ctx.permissionPresets.set(handle.agent.session, 'danger-full-access')
    ctx.sessionTitle.rename(handle.agent.session, title)
    // `admin` carries the authority of the request that created the session: a task
    // worker started by the admin may read across conversations, one started by a
    // group member may not (see tools.ts).
    this.store.set(`role:${sessionId}`, { role, conv, admin })
    return handle.agent
  }

  async resumeAgent(sessionId: string, role: 'chat' | 'task', conv: string): Promise<any> {
    const ctx = this.ctx as any
    if (!(await ctx.sessionPersistence.stat(sessionId))) return undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: this.config.llm.provider, model: this.config.llm.agentModel },
      setup: async (agentCtx: any) => {
        await ctx.agentPresets.mount(agentCtx, this.config.agentPreset)
        this.decorate(agentCtx, role, conv)
      },
    })
    return handle.agent
  }

  /** Role prompt sections (the tools themselves come from the orange preset). */
  decorate(agentCtx: any, role: 'chat' | 'task', conv: string): void {
    const sp = agentCtx.systemPrompt
    const settings = this.store.settings()
    sp.section({
      name: 'orange:role', order: 900, interpolate: false,
      text: () => role === 'chat'
        ? `${CHAT_PERSONA}\n\n你负责的会话：${conv}（${this.store.convTitle(conv)}）\n主人的项目：${settings.ownProjects.map(projectBrief).join('、')}\n子仓库（同一产品的独立仓库，比如客户端和平台 patcher）用 project_repos 查完整清单，别猜路径\n${this.store.settings().personaExtra}`
        : `${TASK_PERSONA}\n\n来源会话：${conv}（${this.store.convTitle(conv)}）`,
    })
    // The style rule is global and read fresh each turn, so editing it in the panel
    // reaches the running sessions; the sub-styles stay out of the prompt on purpose
    // (they are drawn at random when a message is sent — see stylize()).
    sp.section({
      name: 'orange:style', order: 895, interpolate: false,
      text: () => stylePrompt(this.store.settings().style),
    })
    // The 表情 section is global too (chat and task workers both speak in the
    // group): types from the panel, plus the catalogue size as a hint of how
    // much there is to choose from. The pool itself stays behind sticker_search.
    // It deliberately says nothing about the automatic 表情 — see stickerPrompt.
    sp.section({
      name: 'orange:stickers', order: 890, interpolate: false,
      text: () => {
        const st = this.store.settings().stickers
        return stickerPrompt({ types: st.types, count: this.store.enabledStickerCount() })
      },
    })
    if (role === 'chat') {
      sp.context({
        name: 'orange:roles', order: 145,
        text: () => {
          const here = this.store.memberRoles(conv, true).map((r) => `${RANK_LABEL[r.role === 'owner' ? 'owner' : 'administrator']} ${this.display(`${conv.slice(0, 2)}:${r.userId}`)}`)
          const admins = this.config.admins.map((key) => this.display(key))
          const lines: string[] = []
          if (here.length) lines.push(`本群身份（平台给的群成员角色）：${here.join('、')}`)
          else lines.push('本群身份：还没查到群主/群管理员')
          if (admins.length) lines.push(`机器人管理员（全局，消息里标 {机器人管理员} 的人＝主人）：${admins.join('、')}`)
          lines.push('这些身份只影响你怎么称呼和配合他们，不改变你的权限：跨群、改配置、写白名单仍然只限机器人管理员')
          return lines.join('\n')
        },
      })
      sp.context({
        name: 'orange:memory', order: 140,
        text: () => {
          const mem = this.memoryFor(conv)
          return mem.length ? `长期记忆（memory 工具维护）：\n${mem.map((m) => `- #${m.id} [${m.scope}] ${m.text}`).join('\n')}` : ''
        },
      })
    }
  }

  /**
   * The memories one conversation's agent may see: global/project facts, facts filed
   * under this group or its twin, and facts about people who actually speak here.
   * Memory is shared storage, and without this filter a fact learned in group A is
   * recited in group B — the same cross-group leak as reading another chat's history.
   */
  memoryFor(conv: string, query?: string, limit = 30): { id: number, ts: number, scope: string, text: string }[] {
    const peer = this.store.group(conv).peer
    const senders = new Set<string>()
    for (const key of [conv, peer]) {
      if (!key) continue
      for (const m of this.store.recent(key, 200)) senders.add(`${m.conv.slice(0, 2)}:${m.senderId}`)
    }
    const scopes = new Set([`group:${conv}`, peer ? `group:${peer}` : ''])
    return this.store.memories(query, 300).filter((m) => {
      const scope = String(m.scope ?? '')
      if (scope === '' || scope === 'global' || scope.startsWith('project:')) return true
      if (scope.startsWith('group:')) return scopes.has(scope)
      if (scope.startsWith('user:')) return senders.has(scope.slice(5))
      return false
    }).slice(0, limit)
  }

  /** Background worker session for a task; returns the task id. */
  async startTask(conv: string, title: string, kind: string, brief: string, repo?: string, admin = false): Promise<number> {
    const sessionId = `orange-task-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    const id = this.store.createTask({ conv, title, kind, sessionId, repo })
    const agent = await this.createAgent(sessionId, 'task', `🛠 #${id} ${title}`, conv, admin)
    // steer() = 插入到当前轮的下一个 step 边界；followup() 只会排队等这一轮跑完
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: `任务 #${id}（${kind}）：${title}\n来源会话：${conv}\n${repo ? `相关仓库：${repo}\n` : ''}\n${brief}` }],
      source: { kind: 'user' },
    }))
    this.broadcast({ type: 'task', id })
    return id
  }

  async messageTask(id: number, text: string): Promise<boolean> {
    const task = this.store.task(id)
    if (!task) return false
    let agent = this.ctx.agents.get(task.session_id)
    if (!agent) agent = await this.resumeAgent(task.session_id, 'task', task.conv)
    if (!agent) return false
    // 主人/主 agent 的话必须马上让 worker 知道：steer 插进它正在跑的这一轮的下一个
    // step（worker 干活时是 running，followup 得等整轮结束才看得到，可能好几十分钟）
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    this.store.updateTask(id, { status: 'running' })
    return true
  }

  /** When each live agent's current activity began (`agent/status` → running). */
  private readonly runningSince = new Map<string, number>()

  noteAgentStatus(sessionId: string, status: string): void {
    if (status === 'running') { if (!this.runningSince.has(sessionId)) this.runningSince.set(sessionId, Date.now()) }
    else this.runningSince.delete(sessionId)
  }

  /**
   * Background tasks whose worker is executing right now — judged by the live agent,
   * not the `tasks.status` column: a worker that ends its turn without `task_update`
   * leaves its row on "running" forever. `conv` limits it to one group (and its twin).
   */
  runningTasks(conv?: string): { task: any, since: number, exact: boolean, subagents: number }[] {
    const scope = conv ? new Set([conv, this.store.group(conv).peer].filter(Boolean)) : undefined
    const agents = this.ctx.agents.list() as any[]
    const out: { task: any, since: number, exact: boolean, subagents: number }[] = []
    for (const agent of agents) {
      if (agent.status !== 'running') continue
      const task = this.store.taskBySession(String(agent.session.id))
      if (!task || (scope && !scope.has(task.conv))) continue
      const known = this.runningSince.get(String(agent.session.id))
      const subagents = agents.filter((a) => a !== agent && a.status === 'running' && this.ctx.agents.isOwnedBy(a.session.id, agent)).length
      out.push({ task, since: known ?? task.created, exact: known !== undefined, subagents })
    }
    return out.sort((a, b) => a.since - b.since)
  }

  /** `/ai.bg` reply: what is running in the background, and for how long. */
  backgroundReport(conv?: string): string {
    const rows = this.runningTasks(conv)
    const where = conv ? '本群' : ''
    if (!rows.length) return `${where}现在没有后台任务在跑`
    const now = Date.now()
    const lines = rows.map(({ task, since, exact, subagents }) => {
      // `since` is when this run began; a task resumed by task_message has an older creation time
      const bits = [exact ? `已跑 ${humanDuration(now - since)}` : `已跑 ${humanDuration(now - since)}（从建任务算）`]
      if (exact && since - task.created > 60_000) bits.push(`任务建于 ${humanDuration(now - task.created)}前`)
      if (subagents) bits.push(`${subagents} 个子 agent`)
      if (!conv) bits.push(`来自 ${this.store.convTitle(task.conv) || task.conv}`)
      if (task.pr) bits.push(`PR ${task.pr}`)
      else if (task.issue) bits.push(`issue ${task.issue}`)
      return `#${task.id} ${task.title}\n  ${bits.join(' · ')}`
    })
    return `${where}后台在跑 ${rows.length} 个任务：\n${lines.join('\n')}`
  }

  // ----------------------------------------------------------------- style --
  /** Whether this conversation's platform renders markdown (`[文字](url)` links). */
  rendersMarkdown(conv: string): boolean { return conv.startsWith('qq:') }

  /**
   * Rewrite one message into the house style just before it goes out: the main
   * style is fixed and global, the sub-styles are drawn at random per send, so two
   * answers to the same question never come out worded identically. Best-effort by
   * design — a failed call, or an answer that fails `acceptStyled` (dropped link,
   * @, version number, runaway length), sends the text the agent wrote instead.
   *
   * `markdown` is the target platform's capability: on a platform without it the
   * markup is turned into plain text *before* the rewrite (so the model works on —
   * and may pick up the wording of — the text people will actually see), and the
   * prompt tells it not to reintroduce any.
   */
  async stylize(conv: string, text: string, maxChars: number, markdown = true): Promise<{ text: string, applied: boolean, subs: string[], note: string }> {
    const style = this.store.settings().style
    const raw = String(text ?? '').trim()
    const body = markdown ? raw : stripMarkdown(raw)
    if (!body || !style?.enabled) return { text: body, applied: false, subs: [], note: '' }
    const subs = pickSubStyles(style.subs ?? [], style.pickMin, style.pickMax)
    const model = String(style.model ?? '').trim() || this.config.llm.model
    const cfg = { baseURL: this.config.llm.baseURL, apiKey: this.config.llm.apiKey, model }
    const failed = (note: string) => ({ text: body, applied: false, subs, note })
    try {
      const result = await chat(cfg, [
        { role: 'system', content: stylePolishSystem({ main: style.main, subs, maxChars, markdown }) },
        { role: 'user', content: body },
      ], {
        maxTokens: 400,
        temperature: Number.isFinite(style.temperature) ? style.temperature : 1,
        retries: 1,
        retryBudgetMs: 30_000,
        timeoutMs: 20_000,
      })
      this.store.recordLlm({ kind: 'style', model, input: result.input, cached: result.cached, output: result.output, conv })
      const out = acceptStyled(result.text, body, maxChars)
      if (!out) {
        this.log.warn(`style ${conv}: 润色结果不合规，发原文（${result.text.trim().slice(0, 60)}）`)
        return failed('润色结果被丢弃，发的是原文')
      }
      return { text: out, applied: true, subs, note: '' }
    } catch (error) {
      this.log.warn(`style ${conv}: ${(error as Error).message}`)
      return failed('润色失败，发的是原文')
    }
  }

  // ------------------------------------------------------------------ send --
  /**
   * Deliver to a conversation, honoring dry-run, and record the response.
   * Returns platform ids (empty on dry-run).
   *
   * `sticker` marks a 表情 send: it is one flag rather than a look at the parts,
   * because a platform without native 表情 carries the same send as an image
   * (see StickerService.send). `automatic` marks the 表情 the bot appends to a
   * segment it has already finished — same thing on the wire, different meaning
   * for the segment bookkeeping (see noteSend). `stickerLabel` is that 表情's
   * identity (`#158 趴在地上摊平的兽耳少女…`): it replaces the bare `[表情]` /
   * `[图片]` placeholder everywhere we record the send, so the panel and — more
   * importantly — the agent's own history say *which* 表情 went out. Without it
   * the automatic 表情 is untraceable to the agent that "sent" it.
   */
  async send(conv: string, parts: OutboundPart[], opts: { replyTo?: InboundMessage, trigger?: string, sessionId?: string, context?: string, sticker?: boolean, automatic?: boolean, stickerLabel?: string } = {}): Promise<{ ids: string[], dryRun: boolean }> {
    const platform = conv.slice(0, 2) as PlatformKey
    const info = this.store.conversation(conv)
    const channelId = info?.channelId ?? conv.slice(3)
    const direct = info?.direct ?? false
    const group = this.store.group(conv)
    const stickerText = opts.stickerLabel ? `[表情 ${opts.stickerLabel}]` : undefined
    // What this message says, as the agent and the panel read it back: a mention is `@名字` (the
    // markup QQ itself needs never belongs in a record — see humanizeAtMarkup), an attachment is
    // its placeholder. The stored row is the only thing the agent can check its own send against.
    const text = humanizeAtMarkup(parts.map((p) => {
      if (p.type === 'at') return `@${p.name || this.atLabel(conv, p.userId ?? '')}`
      return p.text ?? (p.type === 'image' ? stickerText ?? '[图片]' : p.type === 'sticker' ? stickerText ?? '[表情]' : p.type === 'file' ? `[文件 ${p.name ?? ''}]` : p.type === 'buttons' ? `[按钮 ${p.buttons?.flat().map((b) => b.label).join('/')}]` : '')
    }).join(''), (id) => this.atLabel(conv, id))
    // The repeat guard (see repeat.ts): the same answer must not reach one conversation twice.
    // Every caller passes through here — the chat session's `say`, a background task worker's, the
    // panel's — so a worker answering a question the chat agent already answered is caught too.
    // The answer counts from this moment on, before the bridge is called: the retry the guard has to
    // stop is exactly the one after a send whose outcome we never learned.
    const answer = answerKey(text)
    if (answer.length >= REPEAT_MIN_CHARS) {
      const now = Date.now()
      const seen = (this.recentAnswers.get(conv) ?? []).filter((prev) => now - prev.at < REPEAT_WINDOW_MS)
      const repeat = seen.find((prev) => sameAnswer(prev.key, answer))
      if (repeat) throw new Error(repeatSendError(Math.round((now - repeat.at) / 1000)))
      seen.push({ at: now, key: answer })
      this.recentAnswers.set(conv, seen)
    }
    const record = { ts: Date.now(), conv, trigger: opts.trigger ?? 'agent', sessionId: opts.sessionId, text, dryRun: group.dryRun, delivered: false, context: opts.context }
    const state = this.state(conv)
    state.lastBotTs = Date.now()
    // Segments follow what the bot says, dry run or not: in a dry-run group the
    // auto 表情 is recorded rather than delivered, exactly like the rest.
    this.noteSend(conv, opts.automatic ? 'auto' : opts.sticker ? 'sticker' : 'message')
    if (group.dryRun) {
      this.store.recordResponse(record)
      this.broadcast({ type: 'response', conv })
      return { ids: [], dryRun: true }
    }
    const resolved = await Promise.all(parts.map(async (p) => (p.type === 'image' || p.type === 'file') && p.src ? { ...p, src: await toDataUrl(p.src) } : p))
    try {
      // The userbot account is shared with the admin, so our own sends come back
      // through the feed as ordinary messages: remember what we sent (the text, or
      // the fact that it was a bare 表情) so onMessage can recognize the echo.
      // The label rides along because the echo itself only says `[表情#1]` — the
      // feed numbers attachments, it does not name 表情 — and the stored message
      // should still say which one went out.
      if (platform === 'cg') {
        const sentText = parts.find((p) => p.type === 'text' || p.type === 'markdown')?.text ?? ''
        const hasSticker = parts.some((p) => p.type === 'sticker')
        if (sentText || hasSticker) this.pendingSelfTexts.push({ conv, text: sentText, sticker: hasSticker, label: hasSticker ? stickerText : undefined, ts: Date.now() })
      }
      this.cg.sendPrefix = this.store.settings().botEmojiPrefix ? CrossgramClient.PREFIX : ''
      const ids = await this.client(platform).send(channelId, direct, resolved, opts.replyTo ?? state.lastInbound)
      this.store.recordResponse({ ...record, delivered: true })
      // record our own outgoing message for qq (koishi does not echo it back)
      if (platform === 'qq') {
        // one platform message per flushed segment; record the text once and the rest as attachments
        const media = parts.filter((p) => p.type === 'image' || p.type === 'file').map((p) => ({ kind: p.type, url: p.src ?? '', name: p.name }))
        for (const [index, id] of ids.entries()) {
          const segment = index === 0 ? text : media[index - 1] ? (media[index - 1].kind === 'image' ? stickerText ?? '[图片]' : `[文件 ${media[index - 1].name ?? ''}]`) : '[消息]'
          const stored = this.store.insertMessage({ conv, id, senderId: this.qq.selfId, senderName: '橘波特', ts: Date.now(), text: segment, raw: JSON.stringify({ media: index === 0 ? [] : media.slice(index - 1, index) }), self: true, mentionsSelf: false, fromBot: true })
          if (stored) this.broadcast({ type: 'message', message: stored })
        }
      }
      this.broadcast({ type: 'response', conv })
      return { ids, dryRun: false }
    } catch (error) {
      this.store.recordResponse({ ...record, error: String((error as Error).message ?? error) })
      // 结果未知：桥可能在平台收下这条之后才失败（见 repeat.ts），所以给 agent 的错误里要写明
      // 「别原样重发」——否则它下一轮做的就是再发一遍同一句话。
      throw new Error(`${(error as Error).message ?? error}（${sendUnknownError()}）`)
    }
  }

  sendText(conv: string, text: string, opts: { replyTo?: InboundMessage, trigger?: string } = {}) {
    return this.send(conv, [{ type: 'text', text }], opts)
  }

  /**
   * Track the bot's own speech as per-conversation segments: every message it
   * sends extends the open segment, and `autoGapMs` of silence closes it (see
   * MessageSegments). Closing is where the automatic 表情 happens, unless the
   * segment already carried one — the prompt asks the agent to end a 段话 with a
   * 表情 when it fits, and this covers the times it just does not bother.
   *
   * `auto` is the automatic 表情 itself: it is the epilogue of a segment the
   * bot has already closed, so it neither extends nor reopens anything (it would
   * otherwise arm a segment with nothing in it, and roll for the 表情 that was
   * just sent).
   *
   * Dry-run conversations are tracked too: nothing reaches the group, but the
   * panel then shows the 表情 the bot would have added, which is the point of
   * running a group in dry run.
   */
  private noteSend(conv: string, kind: 'message' | 'sticker' | 'auto'): void {
    if (kind === 'auto') return
    if (kind === 'sticker') this.segments(conv).sticker()
    else this.segments(conv).message()
  }

  /** This conversation's segment tracker, created on first use. */
  private segments(conv: string): MessageSegments {
    const state = this.state(conv)
    state.segments ??= new MessageSegments(
      // read the window afresh every send, so editing it in the panel applies
      // to the segment being built right now
      () => Number(this.store.settings().stickers.autoGapMs) || 7_000,
      (seg) => this.closeSegment(conv, seg),
    )
    return state.segments
  }

  /**
   * A segment of the bot's own messages just ended. With `stickers.autoPercent`
   * chance, one 表情 from the configured type is appended — the machine half of
   * "每段话结束可以加个表情".
   */
  private closeSegment(conv: string, seg: MessageSegment): void {
    const stickers = this.store.settings().stickers
    if (!segmentWantsSticker(seg, stickers.autoPercent, Math.random())) return
    this.log.info(`auto sticker ${conv}: ${seg.messages} 条消息的一段说完了，掷中 ${stickers.autoPercent}%`)
    void this.sendAutoSticker(conv, stickers.autoTag)
      .catch((error) => this.reportError(`auto sticker ${conv}`, error))
  }

  /** Send the closing 表情 of a segment, picked from `tag` (empty = any type). */
  private async sendAutoSticker(conv: string, tag: string): Promise<void> {
    const row = this.stickers.pick({ tags: tag ? [tag] : undefined })
    if (!row) {
      this.log.warn(`auto sticker ${conv}: 没有可用的「${tag}」类表情，跳过`)
      return
    }
    const result = await this.stickers.send(row, conv, { trigger: 'auto', automatic: true })
    this.log.info(`auto sticker ${conv}: 发 #${row.id}（${row.desc || '无描述'}）${result.dryRun ? '，dry-run 只记录' : ''}`)
  }

  /** "Received / ok" acknowledgements: reactions only exist on the userbot side. */
  async react(m: { conv: string, id: string } | InboundMessage, kind: 'ok' | 'bot' | 'thumb' | string): Promise<boolean> {
    const keys: Record<string, string> = { ok: '1:124', bot: '2:129302', thumb: '1:76', received: '1:428' }
    const key = keys[kind] ?? kind
    const conv = m.conv
    if (this.store.group(conv).dryRun) { this.store.recordResponse({ ts: Date.now(), conv, trigger: 'react', text: `[react ${kind}]`, dryRun: true, delivered: false }); return true }
    if (conv.startsWith('cg:')) {
      await this.cg.react(conv.slice(3), m.id, [key])
      this.store.recordResponse({ ts: Date.now(), conv, trigger: 'react', text: `[react ${kind}]`, dryRun: false, delivered: true })
      return true
    }
    // qq official cannot react in groups; find the same message on the userbot side if the group is mapped
    const peer = this.store.group(conv).peer
    if (peer) {
      const original = this.store.byId(conv, m.id)
      const twin = original && this.store.findSimilar(peer, original.text, original.ts)
      if (twin) { await this.cg.react(peer.slice(3), twin.id, [key]); return true }
    }
    return false
  }

  /** How long a message we sent may still be withdrawn (both platforms allow ~2 min). */
  static readonly RECALL_WINDOW_MS = 2 * 60_000

  /**
   * Withdraw one of our own recent messages. Both platforms only accept a
   * recall in the first couple of minutes and only for messages this account
   * itself sent, so the lookup, the ownership check and the age check all live
   * here instead of in the tool (which would otherwise have to guess whether a
   * `#seq` is one of ours).
   */
  async recall(seq: number): Promise<{ ok: boolean, note: string }> {
    const m = this.store.bySeq(Number(seq))
    if (!m) return { ok: false, note: `没有 #${seq} 这条消息` }
    if (!m.fromBot) return { ok: false, note: `#${m.seq} 是别人发的，只能撤回自己（橘波特）发的消息` }
    const age = Date.now() - m.ts
    if (age > OrangeBot.RECALL_WINDOW_MS) {
      return { ok: false, note: `#${m.seq} 已经发出去 ${Math.round(age / 1000)} 秒了，超过两分钟撤不回来` }
    }
    const conv = m.conv
    if (this.store.group(conv).dryRun) return { ok: false, note: `${conv} 是 dry-run 会话，这条消息本来就没有真的发出去` }
    const channelId = this.store.conversation(conv)?.channelId ?? conv.slice(3)
    try {
      if (conv.startsWith('qq:')) {
        const r = await this.qq.ext<{ recalled: string[], failed?: { id: string, error: string }[] }>('recall', { selfId: this.qq.selfId, channelId, messageIds: [m.id] })
        if (r?.failed?.length) return { ok: false, note: `平台拒绝了撤回：${r.failed[0].error}` }
      } else {
        const r = await this.cg.recall(channelId, [m.id])
        if (r?.failed?.length) return { ok: false, note: `平台拒绝了撤回：${r.failed[0].error}` }
      }
    } catch (error) {
      return { ok: false, note: `撤回失败：${(error as Error).message}` }
    }
    this.store.recordResponse({ ts: Date.now(), conv, trigger: 'recall', text: `[撤回 #${m.seq}]`, dryRun: false, delivered: true })
    this.broadcast({ type: 'response', conv })
    return { ok: true, note: `撤回 #${m.seq}（${formatLine(m).slice(0, 60)}…）` }
  }

  // ----------------------------------------------------------------- media --
  /**
   * The stable id of one attachment (see media.ts). The key is derived from where it sat, so the
   * preview rendered at ingest and a `get_forward` a day later hand out the *same* id, and an id
   * the model read long ago still resolves.
   */
  mediaId(entry: MediaEntry): number {
    const key = entry.plan
      ? `forward:${entry.conv}:${entry.messageId}:${entry.plan}`
      : `${entry.source}:${entry.conv}:${entry.messageId}:${entry.kind}:${entry.name ?? ''}:${entry.url ?? ''}`
    return this.store.upsertMedia(key, {
      conv: entry.conv, messageId: entry.messageId, source: entry.source, kind: entry.kind,
      name: entry.name, mime: entry.mime, size: entry.size, width: entry.width, height: entry.height,
      url: entry.url, plan: entry.plan,
    })
  }

  /** The sink one message's attachments are registered through. */
  private mediaSinkFor(context: { conv: string, messageId: string, ts: number, senderName: string }): MediaSpecSink {
    return (spec) => this.mediaId({ ...spec, ...context })
  }

  /**
   * Where one attachment's bytes are, checked by actually getting them. A message's own
   * attachment carries a url we already have. An attachment inside a merged forward cannot: the
   * platform's urls die with their rkey within minutes, so the bundle is asked for again
   * (crossgram) and the url taken from there.
   *
   * The official side is the interesting one. QQ never hands a merged forward over as data — the
   * whole bundle arrives as *one text element*, attachments and all (`message_type 0`; the
   * documented `msg_elements` recursion only exists for 引用消息), and each attachment's url in
   * that rendering is minted either for the bot or for the sender's own client. A bot-minted one
   * (the common case: query appid and the appid inside the fileid agree) downloads fine; a
   * client-minted one answers `{"retcode":-5503023,"retmsg":"appid is not match"}` for every appid
   * we can send, so the twin conversation's copy of the same message is the only source. Which of
   * the two it is cannot be read off the url, so both are tried in turn.
   */
  async mediaUrl(row: MediaRow): Promise<{ url: string } | { error: string }> {
    const plan = parsePlan(row.plan)
    const failed: string[] = []
    /** A url counts as usable only once its bytes actually came back. */
    const attempt = async (label: string, url?: string): Promise<{ url: string } | undefined> => {
      if (!url) return undefined
      try {
        await this.fetchMedia(url)
        return { url }
      } catch (error) {
        failed.push(`${label}：${(error as Error).message}`)
        return undefined
      }
    }
    const giveUp = () => ({ error: `这个附件取不到（${failed.join('；') || '没有可用的地址'}）` })
    if (!plan) return (await attempt('附件自己的地址', row.url)) ?? giveUp()
    if (plan.kind === 'locator') {
      const url = await this.bundleMediaUrl({ locator: plan.locator }, plan.path, plan.position, plan.name).catch(() => undefined)
      return (await attempt('转发里的地址', url)) ?? giveUp()
    }
    // The official side: the url the platform printed for the attachment is tried first (it is
    // the bot's own in the common case and needs no userbot at all), and only if it cannot be
    // fetched is the twin conversation's copy of the same message asked for.
    const direct = await attempt('官方侧给的地址', row.url)
    if (direct) return direct
    const twin = await this.twinForward(row.conv, plan).catch(() => undefined)
    if (!twin) {
      failed.push('userbot 侧也没有找到同一份记录（对方可能撤回了，或者这两个群还没配对）')
      return giveUp()
    }
    const url = await this.bundleMediaUrl({ locator: twin.locator }, twin.path, twin.position, plan.name).catch(() => undefined)
    return (await attempt('userbot 侧同一份', url)) ?? giveUp()
  }

  /** Downloading one url, cached on disk by its address (without the rkey that rotates). */
  async fetchMedia(url: string): Promise<{ path: string, data: Uint8Array }> {
    return fetchMedia(url, this.mediaDir)
  }

  /** The url of one attachment of a bundle: picked by position, checked by name when we have one. */
  private async bundleMediaUrl(ref: { locator?: unknown, snapshot?: BundleItem[] }, path: string, position: number, name?: string): Promise<string | undefined> {
    const all = await this.bundleMedia(ref)
    const at = all.filter((m) => m.path === path)
    const picked = (name ? at.find((m) => sameMedia(m.part.name, name)) : undefined)
      ?? at.find((m) => m.position === position)
      ?? (name ? all.find((m) => sameMedia(m.part.name, name)) : undefined)
    return picked?.part.url
  }

  /**
   * The same bundle as it exists on the other platform. The official side never gives the bot a
   * merged forward as data, only that rendered text, so its attachments are reached through the
   * userbot's copy of the very same message: paired conversation, same sender, same moment, same
   * bundle title.
   */
  private async twinForward(conv: string, plan: ForwardPlan): Promise<{ locator: unknown, path: string, position: number } | undefined> {
    const peer = this.store.group(conv).peer
    if (!peer) return undefined
    const near = this.store.search({
      conv: peer, sender: plan.senderName || undefined,
      since: plan.ts - TWIN_FORWARD_MS, until: plan.ts + TWIN_FORWARD_MS, limit: 20,
    })
    for (const candidate of near) {
      const forwards = (JSON.parse(candidate.raw || '{}').forwards ?? []) as { title?: string, locator?: unknown }[]
      for (const [index, fwd] of forwards.entries()) {
        if (fwd.locator === undefined) continue
        if (plan.forward && fwd.title && String(fwd.title) !== plan.forward) continue
        const all = await this.bundleMedia({ locator: fwd.locator }, String(index + 1)).catch(() => [])
        const picked = (plan.name ? all.find((m) => sameMedia(m.part.name, plan.name)) : undefined)
          ?? all.find((m) => m.path === plan.path && m.position === plan.position)
        if (picked) return { locator: fwd.locator, path: picked.path, position: picked.position }
      }
    }
    return undefined
  }

  /**
   * The attachment an old-style `(seq, index)` — optionally `index` inside a merged forward —
   * names. Rows stored before attachments had ids still carry the old `[图片#n]` markers, so those
   * arguments keep working: they resolve to the same attachment and register its row on the way.
   */
  async legacyMedia(m: StoredMessage, index: number, path?: string): Promise<MediaRow | undefined> {
    if (path) {
      const steps = String(path).split('.').filter((s) => s.length)
      if (!steps.length || steps.some((s) => !/^\d+$/.test(s))) return undefined
      const top = this.forwardsOf(m)[Number(steps[0]) - 1]
      if (!top) return undefined
      // walk from the message's forward, so the paths are the same ones the render labels
      const found = (await this.bundleMedia(top)).find((x) => x.path === path && x.position === index - 1)
      if (!found) return undefined
      const kind = found.part.kind === 'image' ? 'image' : 'file'
      return this.store.media(this.mediaId({
        source: 'forward', kind, name: found.part.name, mime: found.part.mime ?? found.part.mimeType,
        url: found.part.url,
        plan: JSON.stringify(this.forwardPlan(top.locator, path, found.position, found.part, { forward: top.title, ts: m.ts, senderName: m.senderName })),
        conv: m.conv, messageId: m.id, ts: m.ts, senderName: m.senderName,
      }))
    }
    const media = (JSON.parse(m.raw || '{}').media ?? [])[index - 1]
    if (!media?.url) return undefined
    const kind = media.kind === 'image' ? 'image' : 'file'
    return this.store.media(this.mediaId({
      source: 'message', kind, name: media.name, mime: media.mime, url: media.url,
      conv: m.conv, messageId: m.id, ts: m.ts, senderName: m.senderName,
    }))
  }

  async imageBlock(url: string): Promise<any> {    const bytes = await this.fetchMedia(url)
    const mediaType = sniffImage(bytes.data)
    if (!mediaType) return undefined
    const ref = await (this.ctx as any).attachments.saveImage({ data: bytes.data, mediaType, name: 'chat-image' })
    return { type: 'image', attachment: ref }
  }

  async downloadMedia(url: string): Promise<{ path: string, data: Uint8Array }> {
    return this.fetchMedia(url)
  }

  // ---------------------------------------------------------------- errors --
  async reportError(where: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    this.log.warn(`[${where}] ${message}`)
    if (this.stopped) return
    // No report conversation configured (the default): the log line above is the report.
    if (!this.config.errorGroup) return
    const now = Date.now()
    this.errorTimes = this.errorTimes.filter((t) => now - t < 600_000)
    if (this.errorTimes.length >= 5) return
    this.errorTimes.push(now)
    try {
      await this.sendText(this.config.errorGroup, `⚠ ${where}\n${message.slice(0, 800)}`, { trigger: 'error' })
    } catch (e) {
      this.log.warn(`error report failed: ${(e as Error).message}`)
    }
  }
}

export function formatLine(m: StoredMessage, tag?: string, note?: string): string {
  const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(0, 5)
  const reply = m.replyTo ? ` ↩${m.replyTo.slice(-6)}` : ''
  const who = m.fromBot ? '橘波特(你)' : `${m.senderName}${tag ? `{${tag}}` : ''}`
  return `#${m.seq} ${time} ${who}(${m.senderId})${reply}${note ? ` ${note}` : ''}: ${m.text.replace(/\n/g, '\n  ')}`
}

/** Cache key for one person's role in one conversation. */
function roleKey(conv: string, userId: string): string { return `${conv} ${userId}` }

function normalize(text: string): string { return text.replace(/^🤖\s*/, '').replace(/\s+/g, '') }

/**
 * The bodies of the inline `<quote>…</quote>` prefixes a stored text carries: the official
 * QQ groups deliver the referenced message that way (see renderQuote in satori.ts), while
 * pairText() strips those blocks before any cross-platform comparison.
 */
export function quotedBodies(text: string): string[] {
  return [...String(text ?? '').matchAll(/<quote>([\s\S]*?)<\/quote>/g)].map((m) => normalize(m[1]))
}

/**
 * Whether one of those inline bodies is the quote a twin trigger resolved by id. The two
 * renderings are not necessarily identical — one may carry the quoted sender's name, and
 * either side may be truncated — so only a common, long-enough head of the body counts.
 */
export function sameQuote(inline: string[], body: string): boolean {
  const probe = normalize(body)
  if (probe.length < 6) return false
  return inline.some((quote) => {
    // the inline form is `昵称：正文` (see renderQuote), the body here is the正文 alone
    const quoted = quote.replace(/^[^：:]{1,24}[：:]/, '')
    const head = Math.min(probe.length, quoted.length, 40)
    return head >= 6 && probe.slice(0, head) === quoted.slice(0, head)
  })
}

/**
 * The words a person actually typed, without the parts each platform renders its own way:
 * pairText() already drops quotes, mentions, media placeholders and punctuation, and the
 * emoji/face icons (one side sends 🙂 where the other shows [捂脸]) go too. Used to tell a
 * twin copy of a message from a genuinely different one.
 */
function utterance(text: string): string {
  return pairText(text).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function mentionsTopic(text: string, settings: { ownProjects: OwnProject[], assistTopics: { aliases: string[], name: string }[] }): boolean {
  const lower = text.toLowerCase()
  return [...settings.ownProjects, ...settings.assistTopics].some((p) => projectTerms(p).some((a) => a.length > 2 && lower.includes(a.toLowerCase())))
}

/**
 * Words that mean a project: its name/aliases plus the subprojects' (so "mithka
 * 闪退" still counts as talking about crossgram). Subproject names double as the
 * terms the classifier sees, which keeps the two in sync.
 */
export function projectTerms(p: { name: string, aliases: string[], subs?: { name: string, aliases?: string[] }[] }): string[] {
  return [p.name, ...p.aliases, ...(p.subs ?? []).flatMap((s) => [s.name, ...(s.aliases ?? [])])]
}

const MEDIA_LIMIT = 30 * 1024 * 1024

export async function fetchMedia(url: string, dir: string): Promise<{ path: string, data: Uint8Array }> {
  if (url.startsWith('/')) return { path: url, data: new Uint8Array(await readFile(url)) }
  if (url.startsWith('data:')) {
    const data = new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    return { path: '', data }
  }
  await mkdir(dir, { recursive: true })
  const hash = createHash('sha1').update(url.replace(/[?&](rkey|token)=[^&]*/g, '')).digest('hex')
  const cached = join(dir, hash)
  try { await stat(cached); return { path: cached, data: new Uint8Array(await readFile(cached)) } } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`media ${response.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > MEDIA_LIMIT) throw new Error('media too large')
  const ext = sniffImage(data)?.split('/')[1]
  const path = ext ? `${cached}.${ext === 'jpeg' ? 'jpg' : ext}` : cached
  await writeFile(cached, data)
  if (path !== cached) await writeFile(path, data)
  return { path, data }
}

export function sniffImage(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif'
  if (data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

async function toDataUrl(src: string): Promise<string> {
  if (!src.startsWith('/')) return src
  const data = await readFile(src)
  const mime = sniffImage(new Uint8Array(data)) ?? mimeFromExt(extname(src))
  return `data:${mime};base64,${data.toString('base64')}`
}

function mimeFromExt(ext: string): string {
  return ({ '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.json': 'application/json', '.mp4': 'video/mp4', '.log': 'text/plain', '.md': 'text/markdown' } as Record<string, string>)[ext.toLowerCase()] ?? 'application/octet-stream'
}

export type { GroupSettings }
