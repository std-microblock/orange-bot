/**
 * Orange agent tools. Registered by the `dsh-plugin-orange/tools` preset row so
 * every agent on the orange preset (chat sessions, task sessions and their
 * subagents) gets them. A tool resolves its conversation from the calling
 * session (or the root of a subagent chain) through the bot's role table.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OrangeBot } from './bot.ts'
import { formatLine, projectTerms } from './bot.ts'
import type { MediaRef, OutboundPart } from './satori.ts'
import { markdownDropsQuote, quoteBlockquote } from './qq.ts'
import { mentionBody, readableMentions, resolveMention, splitMentions, type MentionPiece } from './mentions.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]
const TEXT_OUT = { schema: { type: 'string' as const }, render: (_a: unknown, v: string) => text(v) }

/** Max characters of one chat message (QQ group chat, anti-flood). */
const MAX_CHARS = 120

export function registerTools(ctx: Context, getBot: () => OrangeBot | undefined): void {
  const bot = (): OrangeBot => {
    const b = getBot()
    if (!b) throw new Error('orange bot is not running')
    return b
  }

  /** Walk up subagent lineage to the root session that owns a role record. */
  const roleOf = (exec: any): { sessionId: string, role: 'chat' | 'task', conv: string, admin: boolean } => {
    let session = exec.agent?.session
    for (let i = 0; session && i < 8; i++) {
      const id = String(session.id)
      const role = bot().store.get<{ role: 'chat' | 'task', conv: string, admin?: boolean } | undefined>(`role:${id}`, undefined)
      if (role) return { sessionId: id, role: role.role, conv: role.conv, admin: !!role.admin }
      const parent = session.header?.parentSession
      session = parent ? (ctx as any).agents.get(parent)?.session : undefined
    }
    return { sessionId: String(exec.agent?.session?.id ?? ''), role: 'task', conv: '', admin: false }
  }

  const triggerAdmin = (sessionId: string): boolean => {
    const turn = bot().turns.get(sessionId)
    const m = turn?.triggerMessage
    return !!m && bot().isAdmin(m.platform, m.senderId)
  }

  /**
   * Whether this session may look beyond the conversation it serves. The authority
   * comes from the request, not the role: a task worker started by the admin keeps
   * it, one started by a group member does not.
   */
  const fullAccess = (own: { sessionId: string, role: 'chat' | 'task', admin: boolean }): boolean =>
    own.role === 'task' ? own.admin : triggerAdmin(own.sessionId)

  /** Conversations this session may read: the one it serves plus its twin, or all of them for the admin. */
  const scopeConvs = (own: { sessionId: string, role: 'chat' | 'task', conv: string, admin: boolean }): Set<string> => {
    if (fullAccess(own)) return new Set(bot().store.conversations().map((c) => c.key))
    const set = new Set<string>()
    if (own.conv) {
      set.add(own.conv)
      const peer = bot().store.group(own.conv).peer
      if (peer) set.add(peer)
    }
    return set
  }

  const assertConv = (own: { sessionId: string, role: 'chat' | 'task', conv: string, admin: boolean }, conv: string): void => {
    if (scopeConvs(own).has(conv)) return
    throw new Error(`conversation ${conv} is out of this session's scope. It only serves ${own.conv}${bot().store.group(own.conv).peer ? ` / ${bot().store.group(own.conv).peer}` : ''}; reading or writing another chat needs a request from the admin.`)
  }

  const resolveConv = (exec: any, conv?: string): string => {
    const own = roleOf(exec)
    if (!conv || conv === own.conv) {
      if (!own.conv) throw new Error('this session is not bound to a conversation; pass conv explicitly')
      return own.conv
    }
    // cross-conversation sends: only a request that came from the admin may reach out
    if (!fullAccess(own)) throw new Error('sending to another conversation requires an admin request')
    return conv
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'say',
    description: `Send a chat message to the conversation (default: the one this session serves). This is the ONLY way your words reach people. Keep it short and chatty (≤${MAX_CHARS} chars, usually ONE short sentence; never paste file paths, log names or internals to non-developers); split rarely. Links: just write [text](url) — markdown is allowed everywhere, the platform decides what renders and platforms without it get plain text ("text url"), so you never have to think about it. The text is rewritten into the current speaking style before it goes out, and that final wording is what the result reports — write the content plainly, don't add flavor words yourself. To @ somebody write \`@名字\` (or the 8-character id in brackets on a message line) right in the text; an @ nobody recognizes stays literal text and the result tells you. Replying with quote ALSO @s the person you reply to, so never @ them by hand on a reply. buttons add tappable buttons (official bot only). Use quote to reply to a specific message (#seq). For long content send an image/file instead. Before sending, check yourself: a reply that is ONLY an acknowledgement ("收到"/"好的"/"我看看") is a react, not a say — call react (plus start_task when there is work) and skip say entirely; never send it first and recall it after.`,
    parameters: {
      text: { type: 'string', description: 'Message text (plain chat style). @某人 by writing @名字 or @id in here.' },
      markdown: { type: 'boolean', description: 'Override whether this conversation renders markdown. Leave it unset: the platform decides (official bot renders [text](url), the userbot gets plain text automatically).' },
      quote: { type: 'integer', description: 'Message #seq to quote-reply (the reply also @s its sender). On the official bot a quote on a markdown message is written into the body as a markdown 引用块 instead of the platform quote (QQ would otherwise draw the body twice); the result shows what went out.' },
      at: { type: 'array', items: { type: 'string' }, description: 'More people to @ before the text (user ids or names). Usually unnecessary: writing @名字 in text is enough.' },
      images: { type: 'array', items: { type: 'string' }, description: 'Image paths (absolute, on this machine) or https URLs.' },
      files: { type: 'array', items: { type: 'string' }, description: 'File paths to upload.' },
      buttons: {
        type: 'array', description: 'Button rows (official bot only). Each button: {label, kind: link|input, data}. link opens a URL; input fills the input box with data.',
        items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true }, kind: { type: 'string', enum: ['link', 'input'], required: true }, data: { type: 'string', required: true } } } },
      },
      conv: { type: 'string', description: 'Target conversation key (qq:<id> / cg:<id>); omit for the current one.' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const b = bot()
      const conv = resolveConv(exec, args.conv)
      const body = String(args.text ?? '').trim()
      if (body.replace(/\]\([^)]*\)/g, ']').length > MAX_CHARS) throw new Error(`message too long (${body.length} chars > ${MAX_CHARS}). This is a group chat: say ONE short thing (the key point or one question), drop explanations/paths/version history. If the person really needs details, render an image/file.`)
      // Style step: the agent writes plain text, the rewrite adds whatever the
      // current style draws for this send (see OrangeBot.stylize). Whether the
      // platform renders markdown is decided here, not by the agent.
      const render = typeof args.markdown === 'boolean' ? args.markdown : b.rendersMarkdown(conv)
      const styled = body ? await b.stylize(conv, body, MAX_CHARS, render) : { text: '', applied: false, subs: [] as string[], note: '' }
      const out = styled.text
      if (out.replace(/\]\([^)]*\)/g, ']').length > MAX_CHARS) throw new Error(`the styled wording came out over ${MAX_CHARS} chars (${out.length}). Say the same thing shorter.`)
      // A quote cannot ride along with a markdown body on the official bot (QQ
      // then draws the body twice — see qq.ts), so there the quoted line is
      // written into the body as a markdown blockquote; plain text and the
      // userbot keep the platform's own 引用回复.
      const quoted = args.quote ? b.store.bySeq(Number(args.quote)) : undefined
      const quotedHere = quoted && quoted.conv === conv ? quoted : undefined
      const quotedLine = quotedHere && render && out ? quoteBlockquote({ name: quotedHere.senderName, text: quotedHere.text }) : ''
      // ---- who this message @s -------------------------------------------------
      // Two sources: what the agent wrote in the text (`@名字` / `@id` — see mentions.ts for how a
      // nickname or an id tail is turned into a real id), and the person this message replies to.
      // A reply that reaches nobody is the same as no reply, and on the official bot the @ is the
      // only notification there is: its native quote is dropped on markdown messages.
      const candidates = b.mentionCandidates(conv)
      const { pieces, missing } = splitMentions(out, candidates)
      const targets: MentionPiece[] = []
      const mentioned = new Set(pieces.flatMap((piece) => piece.type === 'at' ? [piece.id] : []))
      // No automatic @ of the person we reply to: the mention path is the most
      // fragile part of the send pipeline; a quote alone identifies the target.
      // const reply = b.replyMention(conv, quotedHere) — dropped on purpose.
      for (const raw of args.at ?? []) {
        const hit = resolveMention(candidates, String(raw))
        const id = hit?.id ?? String(raw)
        if (!id || mentioned.has(id)) continue
        mentioned.add(id)
        targets.push({ type: 'at', id, ...(hit?.name ? { name: hit.name } : {}) }, { type: 'text', text: ' ' })
      }
      const seq: MentionPiece[] = [...targets, ...pieces]
      const parts: OutboundPart[] = []
      if (quotedHere && !quotedLine) parts.push({ type: 'quote', messageId: quotedHere.id })
      // Which shape an @ takes is the platform's business, not the body's — see mentionBody.
      for (const part of mentionBody(seq, { platform: b.platformOf(conv), markdown: render, quoteLine: quotedLine || undefined })) {
        parts.push(part as OutboundPart)
      }
      for (const src of args.images ?? []) parts.push({ type: 'image', src: String(src) })
      for (const src of args.files ?? []) parts.push({ type: 'file', src: String(src), name: String(src).split('/').pop() })
      if (args.buttons?.length) parts.push({ type: 'buttons', buttons: args.buttons })
      if (!parts.length) throw new Error('nothing to send')
      const own = roleOf(exec)
      const turn = b.turns.get(own.sessionId)
      // The guard is belt and braces: the quote above is already written into the
      // body, but nothing may ever hand the adapter a markdown part plus a quote.
      const outgoing = markdownDropsQuote(parts)
      const { dryRun } = await b.send(conv, outgoing, {
        replyTo: turn?.conv === conv ? turn.triggerMessage : undefined,
        trigger: own.role === 'task' ? 'task' : (turn?.trigger ?? 'agent'),
        sessionId: own.sessionId,
        context: styled.applied && styled.subs.length ? `润色｜随机子风格：${styled.subs.join(' / ')}` : undefined,
      })
      // The agent never sees its own message any other way: report what actually left
      // the building, wording included, so a bad rewrite is visible to it.
      const readable = readableMentions(seq)
      const sent = quotedLine ? `${quotedLine}\n\n${readable}` : readable
      const what = sent ? `实际发出：「${sent}」` : '实际发出：（没有文字，只有图片/文件/按钮）'
      const how = styled.applied
        ? `｜已按风格润色${styled.subs.length ? `（本次随机 ${styled.subs.length} 条子风格）` : '（这次没抽到子风格）'}`
        : styled.note ? `｜${styled.note}` : ''
      const quoteNote = quotedLine
        ? '｜引用写在正文引用块里（QQ 官方 bot 的 markdown 消息带原生引用会把正文显示两遍）'
        : (!dryRun && outgoing.length !== parts.length ? '｜引用回复已省略（QQ 官方 bot 的 markdown 消息带引用会让客户端把正文显示两遍）' : '')
      const ated = targets.flatMap((piece) => piece.type === 'at' ? [`@${piece.name ?? b.atLabel(conv, piece.id)}`] : [])
      const atNote = ated.length ? `｜已 @ ${ated.join('、')}` : ''
      const missNote = missing.length ? `｜这些 @ 没认出来（名字或 id 对不上，原样留在文字里了）：${missing.map((token) => `@${token}`).join('、')}` : ''
      return `${dryRun ? 'recorded (dry-run 会话：只记录，没有真的发出去)' : 'sent'}｜${what}${how}${atNote}${quoteNote}${missNote}`
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'react',
    description: 'Put a reaction on a message instead of replying, e.g. to acknowledge ("ok"/"received"/"thumb"/"bot"). Works on the userbot side; on official-bot-only groups it may be unavailable.',
    parameters: {
      seq: { type: 'integer', required: true, description: 'Message #seq.' },
      kind: { type: 'string', enum: ['ok', 'received', 'thumb', 'bot'], required: true },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const b = bot()
      const m = b.store.bySeq(Number(args.seq))
      if (!m) throw new Error('unknown message')
      resolveConv(exec, m.conv)
      return (await b.react({ conv: m.conv, id: m.id }, args.kind)) ? 'reacted' : 'reaction not supported here; skip it'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'send_sticker',
    description: `Send one 表情 from the sticker pool to the conversation (default: the one this session serves). A 表情 is punctuation, not a reply: use it occasionally for a feeling words cannot carry, and sometimes send NOTHING ELSE (a bare 表情 is a complete reply — for "被逗笑了/无语/接不上话" that is usually the right answer). Never send one per message: if the last thing you sent was a 表情, say something instead. Pass id to send a specific one (see sticker_search), or tag/hint and the bot picks. tag may be given several times (types are ANDed). The result tells you the description of the 表情 that actually went out, so you know what you just sent.`,
    parameters: {
      id: { type: 'integer', description: 'Sticker id from sticker_search; omit to let the bot pick from tag/hint.' },
      tag: { type: 'array', items: { type: 'string' }, description: 'Only pick from these types (ids from the system prompt, e.g. speechless). Several are ANDed.' },
      hint: { type: 'string', description: 'What you want to express, e.g. "无语" / "被逗笑" — matched against the descriptions.' },
      conv: { type: 'string', description: 'Target conversation key; omit for the current one.' },
      at: { type: 'array', items: { type: 'string' }, description: 'User ids to @ alongside the 表情.' },
      quote: { type: 'integer', description: 'Message #seq to reply to with the 表情.' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const b = bot()
      const own = roleOf(exec)
      const conv = resolveConv(exec, args.conv)
      const row = args.id
        ? b.stickers.get(Number(args.id))
        : b.stickers.pick({ tags: args.tag?.map(String), hint: args.hint ? String(args.hint) : undefined })
      if (!row) throw new Error(args.id ? `没有 id=${args.id} 的表情` : '表情库里没有符合条件的表情（换个 tag/hint，或者不加条件）')
      const turn = b.turns.get(own.sessionId)
      const candidates = b.mentionCandidates(conv)
      const at = (args.at ?? []).map((raw: any) => {
        const hit = resolveMention(candidates, String(raw))
        return hit ? { id: hit.id, ...(hit.name ? { name: hit.name } : {}) } : { id: String(raw) }
      })
      const result = await b.stickers.send(row, conv, {
        at,
        quoteSeq: args.quote ? Number(args.quote) : undefined,
        replyTo: turn?.conv === conv ? turn.triggerMessage : undefined,
        trigger: own.role === 'task' ? 'task' : (turn?.trigger ?? 'agent'),
        sessionId: own.sessionId,
      })
      const sent = `#${row.id} [${row.tags.map((t) => b.stickers.typeName(t)).join('/') || '未分类'}]：${row.desc || '(这张还没有描述)'}`
      return result.dryRun
        ? `recorded（dry-run 会话：只记录，没有真的发出去）｜本来要发的是 ${sent}`
        : `sent（${result.ids.length ? `消息 id ${result.ids.join(',')}，两分钟内可以 recall 撤回` : '已发出'}）｜刚发出去的表情是 ${sent}`
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sticker_search',
    description: 'Look at the sticker pool before sending one: filter by type (tag) and/or free-text keyword, and get back "#id [类型] 权重 用过N次 一句话描述" lines. Use it when you want a 表情 that really fits; then pass the id to send_sticker.',
    parameters: {
      tag: { type: 'array', items: { type: 'string' }, description: 'Type ids to require (ANDed). Omit for all.' },
      query: { type: 'string', description: 'Keyword matched against the descriptions.' },
      limit: { type: 'integer', description: 'How many to show (default 20, max 60).' },
    },
    output: TEXT_OUT,
    async execute(args: any) {
      const b = bot()
      const rows = b.stickers.search({ tags: args.tag?.map(String), query: args.query ? String(args.query) : undefined, limit: Number(args.limit) || 20 })
      if (!rows.length) {
        const counts = b.stickers.tagCounts()
        return `没有符合条件的表情。现有的类型和数量：${b.stickers.types().map((t) => `${t.name}(${t.id})=${counts[t.id] ?? 0}`).join('、')}`
      }
      return b.stickers.describe(rows)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'recall',
    description: 'Withdraw a message you sent in this conversation. Both platforms only allow this within about two minutes of the send and only for messages the bot itself sent, so use it right after a genuinely bad send (wrong wording, sent to the wrong place, an image with a mistake). It is not an undo for picking the wrong tool: a message that should have been a reaction reveals a decision you had to make BEFORE sending — react directly next time instead of saying and recalling.',
    parameters: { seq: { type: 'integer', required: true, description: 'The #seq of the message to withdraw (it must be one 橘波特 sent).' } },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const b = bot()
      const m = b.store.bySeq(Number(args.seq))
      if (!m) throw new Error(`没有 #${args.seq} 这条消息`)
      assertConv(roleOf(exec), m.conv)
      const result = await b.recall(Number(args.seq))
      if (!result.ok) throw new Error(result.note)
      return result.note
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'no_reply',    description: 'Decide not to say anything for this event (use when the classifier woke you but you have nothing valuable to add). Ends your turn.',
    parameters: { reason: { type: 'string', description: 'Short reason (for logs).' } },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const own = roleOf(exec)
      bot().store.recordResponse({ ts: Date.now(), conv: own.conv, trigger: 'no_reply', sessionId: own.sessionId, text: `(no_reply) ${args.reason ?? ''}`, dryRun: false, delivered: false })
      exec.concludeTurn()
      return 'ok'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chat_history',
    description: 'Read chat history of a conversation (default current: the group this session serves, plus its twin on the other platform when the admin asked). Returns lines "#seq time name(id): text". Page backwards with before_seq.',
    parameters: {
      conv: { type: 'string', description: 'Conversation key; omit for current. Another conversation needs an admin request.' },
      limit: { type: 'integer', description: 'Number of messages (default 40, max 200).' },
      before_seq: { type: 'integer', description: 'Only messages before this #seq.' },
      around_seq: { type: 'integer', description: 'Messages around this #seq.' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const b = bot()
      const own = roleOf(exec)
      const conv = args.conv || own.conv
      if (!conv) throw new Error('conv required')
      assertConv(own, conv)
      const limit = Math.min(200, Number(args.limit) || 40)
      let rows
      if (args.around_seq) {
        const before = b.store.recent(conv, Math.floor(limit / 2), Number(args.around_seq) + 1)
        rows = [...before, ...b.store.after(conv, Number(args.around_seq), Math.ceil(limit / 2))]
      } else rows = b.store.recent(conv, limit, args.before_seq ? Number(args.before_seq) : undefined)
      return rows.length ? rows.map((m) => formatLine(m, b.tag(m.conv, m.senderId))).join('\n') : '(no messages)'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'chat_search',
    description: 'Search recorded messages by keyword / sender / time. Scoped to the group this session serves (and its twin); searching other groups needs an admin request. Never use it to dig up what people said elsewhere.',
    parameters: {
      query: { type: 'string', description: 'Substring to search for.' },
      sender: { type: 'string', description: 'Sender id or name.' },
      conv: { type: 'string', description: 'Restrict to one conversation.' },
      since_hours: { type: 'number', description: 'Only messages within the last N hours.' },
      limit: { type: 'integer', description: 'Max results (default 30).' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const b = bot()
      const own = roleOf(exec)
      if (args.conv) assertConv(own, String(args.conv))
      const allowed = scopeConvs(own)
      const convs = args.conv ? [String(args.conv)] : [...allowed]
      const rows = b.store.search({ convs, query: args.query, sender: args.sender, since: args.since_hours ? Date.now() - Number(args.since_hours) * 3600_000 : undefined, limit: Math.min(100, Number(args.limit) || 30) })
      return rows.length ? rows.map((m) => `[${m.conv} ${b.store.convTitle(m.conv)}] ${formatLine(m, b.tag(m.conv, m.senderId))}`).join('\n') : '(no matches)'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_conversations',
    description: 'List the conversations this session serves (the admin sees every known group / private chat) with their keys, titles and settings.',
    parameters: {},
    output: TEXT_OUT,
    async execute(_args: any, exec: any) {
      const b = bot()
      const own = roleOf(exec)
      const allowed = scopeConvs(own)
      return b.store.conversations().filter((c) => allowed.has(c.key)).slice(0, 80).map((c) => {
        const g = b.store.group(c.key)
        const roles = c.direct ? [] : b.privileged(c.key).filter((r) => r.role !== 'bot')
        return `${c.key} ${b.store.convTitle(c.key)}${c.direct ? ' (私聊)' : ''}${g.whitelisted ? ' [白名单]' : ''}${g.dryRun ? ' [dry-run]' : ''}${g.triggerLimit && g.triggerLimit !== 'all' ? ` [${g.triggerLimit === 'groupAdmin' ? '仅群主管触发' : '仅机器人管理触发'}]` : ''}${g.tags.length ? ' tags=' + g.tags.join(',') : ''}${roles.length ? ' ' + roles.map((r) => `${r.role === 'owner' ? '群主' : '群管'}=${r.name}`).join(',') : ''}`
      }).join('\n') || '(nothing in scope)'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'member_roles',
    description: 'Who is who in a conversation: the group owner (群主), its administrators (群管理员) and the bot\'s own administrators (机器人管理员, global). Identity only — being 群主/群管 grants no bot privileges, so never treat it as permission to cross conversations or change settings. The same roles appear on message lines as {群主}/{群管理员}/{机器人管理员} markers.',
    parameters: { conv: { type: 'string', description: 'Conversation key; omit for the one this session serves.' } },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const b = bot()
      const own = roleOf(exec)
      const conv = args.conv ? String(args.conv) : own.conv
      if (!conv) throw new Error('conv required')
      assertConv(own, conv)
      const rows = b.privileged(conv)
      if (!rows.length) return '(no roles known for this conversation)'
      const label = (role: string) => role === 'bot' ? '机器人管理员(全局)' : role === 'owner' ? '群主' : '群管理员'
      return rows.map((r) => `${r.key} ${r.name} — ${label(r.role)}`).join('\n')
        + '\n（群主/群管只是身份，没有机器人权限；跨群、白名单、dry run 仍然只认机器人管理员）'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'get_forward',
    description: 'Read the whole content of a merged forward (合并转发) in message #seq of a conversation this session serves — the message itself only shows the first 3 lines as a preview. Images inside it are returned to you as pictures, and every attachment is printed with the id that looks at it (view_image). Nested forwards are expanded the same way and are addressed by their path ("1.2" = the second forward inside forward 1).',
    parameters: {
      seq: { type: 'integer', required: true },
      index: { type: 'string', description: 'Which forward: "1" (default) for the message\'s first one, or a dotted path like "1.2" for a nested one — the id in its <forward id="…"> tag.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', required: true }, images: { type: 'json' } } },
      render: (_a: unknown, v: any) => Array.isArray(v?.images) && v.images.length ? [{ type: 'text' as const, text: v.note }, ...v.images] : text(v.note),
    },
    async execute(args: any, exec: any) {
      const b = bot()
      const m = b.store.bySeq(Number(args.seq))
      if (!m) throw new Error('unknown message')
      assertConv(roleOf(exec), m.conv)
      const path = String(args.index ?? '1').trim() || '1'
      const content = await b.forwardContent(m, path).catch(() => undefined)
      if (!content) return { note: `没有 forward index="${path}"（看看消息里的 <forward id="…"> 标签），或者这条转发已经取不到了`, images: [] }
      const images: any[] = []
      let failed = 0
      for (const id of content.ids.slice(0, 8)) {
        const row = b.store.media(id)
        if (!row) continue
        const found = await b.mediaUrl(row).catch(() => undefined)
        if (!found || !('url' in found)) { failed += 1; continue }
        const image = await b.imageBlock(found.url).catch(() => undefined)
        if (image) images.push(image)
      }
      const note = `${content.text}\n（附件就用消息里的 id 取：view_image(id)，比如 [图片 #12]。${images.length ? `${images.length} 张图片已附在下面` : '这次没能附上图片'}${failed ? `，有 ${failed} 个附件取不到` : ''}）`
      return { note, images }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'view_image',
    description: 'Look at an image, or download a file, by the id it is printed with in the chat: `[图片 #12]`, `[文件 #13 log.zip]`. It makes no difference where the attachment was — the message itself, the message it quotes, or a merged forward, on either platform. (Older records still print `[图片#1]`; those are reached with seq + index, plus forward="1" for one inside a forward.)',
    parameters: {
      id: { type: 'integer', description: 'The attachment id from `[图片 #id]` / `[文件 #id …]`.' },
      seq: { type: 'integer', description: 'Legacy: message number, only for records stored before attachments had ids.' },
      index: { type: 'integer', description: 'Legacy: 1-based attachment number of that message.' },
      forward: { type: 'string', description: 'Legacy: merged-forward path the index belongs to ("1", "1.2", …).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', required: true }, image: { type: 'json' } } },
      render: (_a: unknown, v: any) => v.image ? [{ type: 'text', text: v.note }, v.image] : text(v.note),
    },
    async execute(args: any, exec: any) {
      const b = bot()
      const own = roleOf(exec)
      let row = args.id === undefined || args.id === null || args.id === '' ? undefined : b.store.media(Number(args.id))
      if (row) {
        assertConv(own, row.conv)
      } else if (args.seq === undefined || args.seq === null || args.seq === '') {
        throw new Error(args.id === undefined || args.id === null || args.id === ''
          ? 'pass id (from [图片 #id] / [文件 #id …])'
          : `没有 #${args.id} 这个附件（id 来自消息里的 [图片 #id]/[文件 #id]）`)
      } else {
        const m = b.store.bySeq(Number(args.seq))
        if (!m) throw new Error('unknown message')
        assertConv(own, m.conv)
        const path = args.forward === undefined || args.forward === null || args.forward === '' ? undefined : String(args.forward).trim()
        row = await b.legacyMedia(m, Number(args.index) || 1, path)
        if (!row) throw new Error(path
          ? `no attachment #${Number(args.index) || 1} inside forward "${path}"`
          : 'no such attachment in that message')
      }
      const found = await b.mediaUrl(row)
      if (!('url' in found)) throw new Error(found.error)
      const label = row.name ? `#${row.id} (${row.name})` : `#${row.id}`
      const local = await b.downloadMedia(found.url)
      if (row.kind === 'image') {
        const image = await b.imageBlock(found.url).catch(() => undefined)
        return image
          ? { note: `附件 ${label}（也存到了 ${local.path}）`, image }
          : { note: `附件 ${label} 不是能直接看的图片，已存到 ${local.path}（${local.data.byteLength} bytes）` }
      }
      return { note: `已下载附件 ${label}：${local.path}（${local.data.byteLength} bytes）` }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory',
    description: 'Long-term memory shared by all conversations, filtered by scope: file facts about a group under group:<conv> and about a person under user:<id>, or they will not be visible where they belong. action=add stores a fact (scope: user:<id> / group:<conv> / project:<name> / global), search finds facts visible here, delete removes by id.',
    parameters: {
      action: { type: 'string', enum: ['add', 'search', 'delete'], required: true },
      text: { type: 'string' }, scope: { type: 'string' }, query: { type: 'string' }, id: { type: 'integer' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const store = bot().store
      if (args.action === 'add') return `saved #${store.addMemory(String(args.scope ?? 'global'), String(args.text ?? ''))}`
      if (args.action === 'delete') { store.deleteMemory(Number(args.id)); return 'deleted' }
      const rows = bot().memoryFor(roleOf(exec).conv, args.query, 50)
      return rows.length ? rows.map((r) => `#${r.id} [${r.scope}] ${r.text}`).join('\n') : '(none)'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'user_tag',
    description: 'Set or clear a tag on a user (fixed tag set: dev = is a developer, use technical language with them).',
    parameters: { user: { type: 'string', required: true, description: 'User key qq:<id>/cg:<id> or raw id in the current platform.' }, tag: { type: 'string', enum: ['dev'], required: true }, on: { type: 'boolean', required: true } },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const own = roleOf(exec)
      const key = String(args.user).includes(':') ? String(args.user) : `${own.conv.slice(0, 2)}:${args.user}`
      bot().store.setUserTag(key, args.tag, !!args.on)
      return 'ok'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_repos',
    description: "A project of the owner's and every repository it lives in: the main repo plus the sibling repos of the same product (clients, platform patchers, website), each with the path to read or patch it under ~/workspace. Call this before working on a report that may not belong to the main repo.",
    parameters: {
      query: { type: 'string', description: 'Project name/alias, repo or subproject, to filter; omit for every project.' },
    },
    output: TEXT_OUT,
    async execute(args: any) {
      const all = bot().store.settings().ownProjects
      const q = String(args.query ?? '').trim().toLowerCase()
      const hit = q ? all.filter((p) => projectTerms(p).concat(p.repo).some((t) => t.toLowerCase().includes(q))) : all
      if (!hit.length) return `(no project matches "${args.query}")`
      return hit.map((p) => [
        `${p.name} — ${p.note}`,
        `  主仓库 ${p.repo} → ~/workspace/${p.repo.split('/').pop()}`,
        ...(p.subs ?? []).map((s) => `  子仓库 ${s.repo} → ~/workspace/${s.repo}${s.note ? `（${s.note}）` : ''}`),
      ].join('\n')).join('\n')
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'start_task',
    description: 'Hand heavy work to a background worker session: investigate a bug, reproduce, fix and open a PR, implement a feature request, or research a question in depth. The worker reports back in the chat itself. Search existing tasks first (list_tasks) to avoid duplicates.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title.' },
      kind: { type: 'string', enum: ['bugfix', 'feature', 'research', 'other'], required: true },
      repo: { type: 'string', description: 'owner/name if it concerns a repository.' },
      tier: { type: 'string', enum: ['fast', 'quality'], description: 'Worker model tier: quality for writing/fixing code and PRs (correctness matters), fast for research/lookup/quick answers (speed matters). The panel maps tiers to concrete models.' },
      brief: { type: 'string', required: true, description: 'Everything the worker needs: the report, versions, logs (#seq refs), what the user expects, and what to deliver.' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const own = roleOf(exec)
      const tier = args.tier === 'fast' || args.tier === 'quality' ? args.tier : undefined
      const id = await bot().startTask(own.conv, String(args.title), String(args.kind), String(args.brief), args.repo, fullAccess(own), tier)
      return `task #${id} started`
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_tasks',
    description: 'List background tasks (id, status, repo, issue/PR links), optionally filtered by keyword. Status shown is corrected against the live worker agent: a task claiming "running" shows idle (worker alive but not working) or dead (no worker at all — crashed or lost to a restart; task_message can revive it) when nobody is actually executing it.',
    parameters: { query: { type: 'string' } },
    output: TEXT_OUT,
    async execute(args: any) {
      const b = bot()
      // the tasks.status column only changes when the worker itself calls task_update;
      // a crashed or silent worker leaves "running" forever, so judge by the live agent
      const agent = new Map((b.ctx.agents.list() as any[]).map((a) => [String(a.session.id), a]))
      const rows = b.store.tasks(30, args.query).map((t: any) => {
        if (t.status !== 'running') return t
        const a = agent.get(String(t.session_id))
        return { ...t, status: a?.status === 'running' ? 'running' : a ? 'idle' : 'dead' }
      })
      return rows.length ? rows.map((t: any) => `#${t.id} [${t.status}] ${t.kind} ${t.title}${t.repo ? ' ' + t.repo : ''}${t.model ? ' (' + t.model + ')' : ''}${t.issue ? ' issue=' + t.issue : ''}${t.pr ? ' pr=' + t.pr : ''} (from ${t.conv})${t.note ? ' — ' + t.note : ''}`).join('\n') : '(none)'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_message',
    description: 'Send instructions or new information to an existing background task (e.g. requested PR changes); it resumes the original worker session.',
    parameters: { id: { type: 'integer', required: true }, text: { type: 'string', required: true } },
    output: TEXT_OUT,
    async execute(args: any) {
      return (await bot().messageTask(Number(args.id), String(args.text))) ? 'delivered' : 'task not found'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_update',
    description: 'Background workers: record progress on the current task (status, issue/PR url, note).',
    parameters: {
      id: { type: 'integer', description: 'Task id (default: the task of this session).' },
      status: { type: 'string', enum: ['running', 'waiting', 'done', 'failed'] },
      issue: { type: 'string' }, pr: { type: 'string' }, note: { type: 'string' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const own = roleOf(exec)
      const task = args.id ? bot().store.task(Number(args.id)) : bot().store.taskBySession(own.sessionId)
      if (!task) throw new Error('no task')
      const patch: any = {}
      for (const k of ['status', 'issue', 'pr', 'note']) if (args[k] !== undefined) patch[k] = String(args[k])
      bot().store.updateTask(task.id, patch)
      bot().broadcast({ type: 'task', id: task.id })
      return 'updated'
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'group_config',
    description: 'Admin only (the triggering user must be an admin): change conversation settings — whitelist (bot may respond), dry_run (generate but never deliver), listen (classifier participation), trigger_limit (who may @/reply-trigger: all / groupAdmin 群主+群管理员 / botAdmin 机器人管理员), tags/note for the classifier.',
    parameters: {
      conv: { type: 'string', description: 'Conversation key; default current.' },
      whitelisted: { type: 'boolean' }, dry_run: { type: 'boolean' }, listen: { type: 'boolean' },
      trigger_limit: { type: 'string', description: 'all | groupAdmin | botAdmin' },
      tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
    },
    output: TEXT_OUT,
    async execute(args: any, exec: any) {
      const own = roleOf(exec)
      if (!triggerAdmin(own.sessionId)) throw new Error('only an admin can change settings')
      const conv = args.conv || own.conv
      const patch: any = {}
      if (args.whitelisted !== undefined) patch.whitelisted = !!args.whitelisted
      if (args.dry_run !== undefined) patch.dryRun = !!args.dry_run
      if (args.listen !== undefined) patch.listen = !!args.listen
      if (args.trigger_limit !== undefined) patch.triggerLimit = ['all', 'groupAdmin', 'botAdmin'].includes(args.trigger_limit) ? args.trigger_limit : 'all'
      if (args.tags !== undefined) patch.tags = args.tags
      if (args.note !== undefined) patch.note = String(args.note)
      const next = bot().store.updateGroup(conv, patch)
      bot().broadcast({ type: 'settings' })
      return JSON.stringify(next)
    },
  })))
}
