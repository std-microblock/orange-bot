/**
 * `@某人` in the text the agent writes.
 *
 * A message line reads `#12 10:23 蔚敏电阻(CCB9C48C): …` — `formatLine` prints the *tail* of an
 * id, never the whole thing — and a mention of somebody else arrives in the text as `@名字`
 * (userbot) or `@<32 位 openid>` (official bot). So what the model can put after an `@` is a
 * nickname, an id fragment, or the full id it copied out of a line; turning any of those into
 * the id a platform needs for a real @ is this module's whole job.
 *
 * Anything that does not resolve stays literal text: a wrong @ pings a wrong person, while a
 * literal `@xxx` only looks odd. The unresolved ones are handed back so the tool can tell the
 * agent its @ never landed.
 *
 * Import-free apart from qq.ts's `atMarkup` (the same pure-module rule): `vm/debug/at-test.ts`
 * drives all of it without a bot, a database or a network.
 */
import { atMarkup } from './qq.ts'

export interface MentionCandidate {
  /** The id the platform takes for a real @: a QQ member openid, or a userbot NT uid. */
  id: string
  /** Nickname, when we know one. */
  name?: string
  /** The bot's own account: recognized (so it is not reported as unknown), never mentioned. */
  self?: boolean
}

/** One run of an outgoing message: text as written, or a person to @ in its place. */
export type MentionPiece =
  | { type: 'text', text: string }
  | { type: 'at', id: string, name?: string }

/** An id fragment shorter than this is not treated as an id at all. */
const MIN_SUFFIX = 4
/**
 * Nicknames shorter than this are only matched exactly, never as a prefix: a one-character
 * nickname would swallow the first character of the sentence that follows it.
 */
const MIN_NAME = 2

/** The id-shaped run right after the `@`: `CCB9C48C`, `u_KEv-eyK0…`, `A1B2…`. */
const ID_TOKEN = /^[A-Za-z0-9_-]{2,64}/
/** A token nobody recognized, for the «this @ did not land» note. Ids and nicknames only. */
const LOOSE_TOKEN = /^[^\s@，。！？、,.!?~（）()「」【】\[\]<>]{1,32}/
/** `me@example.com`, `a+b@c`: an `@` glued to a word is an address, not somebody to @. */
const EMAIL_BEFORE = /[A-Za-z0-9._%+-]$/

/**
 * The person a token means, or nothing. Order matters: the full id first, then an exact
 * nickname, then the id tail the message lines print. `candidates` is newest-first, so the
 * first hit of a suffix is the person who spoke most recently — a suffix is all the model saw.
 */
export function resolveMention(candidates: MentionCandidate[], token: string): MentionCandidate | undefined {
  const needle = String(token ?? '').trim().replace(/^@/, '')
  if (!needle) return undefined
  const lower = needle.toLowerCase()
  const exact = candidates.find((c) => c.id.toLowerCase() === lower)
  if (exact) return exact
  const named = candidates.find((c) => (c.name ?? '').trim().toLowerCase() === lower)
  if (named) return named
  if (needle.length >= MIN_SUFFIX) return candidates.find((c) => c.id.toLowerCase().endsWith(lower))
  return undefined
}

/**
 * Split a message body at every `@…` that resolves to one of `candidates`.
 *
 * Nicknames are matched by prefix, longest first, because Chinese has no spaces between words:
 * `@张三你好` is 「张三」 followed by their sentence whenever 张三 is somebody we know — and a
 * longer name that also matches wins (`@张三丰` is 张三丰, not 张三 + 丰).
 */
export function splitMentions(text: string, candidates: MentionCandidate[]): { pieces: MentionPiece[], missing: string[] } {
  const source = String(text ?? '')
  const pieces: MentionPiece[] = []
  const missing: string[] = []
  const named = candidates
    .filter((c) => (c.name ?? '').trim().length >= MIN_NAME)
    .sort((a, b) => (b.name ?? '').trim().length - (a.name ?? '').trim().length)
  const flush = (buffer: string) => { if (buffer) pieces.push({ type: 'text', text: buffer }) }
  let cursor = 0
  let buffer = ''
  while (cursor < source.length) {
    const at = source.indexOf('@', cursor)
    if (at < 0) { buffer += source.slice(cursor); break }
    buffer += source.slice(cursor, at)
    const rest = source.slice(at + 1)
    // 1. somebody's nickname, longest match wins
    const byName = named.find((c) => rest.toLowerCase().startsWith((c.name ?? '').trim().toLowerCase()))
    if (byName) {
      const length = (byName.name ?? '').trim().length
      if (byName.self) buffer += `@${rest.slice(0, length)}`
      else { flush(buffer); buffer = ''; pieces.push(atPiece(byName)) }
      cursor = at + 1 + length
      continue
    }
    // 2. an id (or the tail of one) copied out of a message line
    const token = ID_TOKEN.exec(rest)?.[0]
    if (token && token.length >= 2) {
      const hit = resolveMention(candidates, token)
      if (hit) {
        if (hit.self) buffer += `@${token}`
        else { flush(buffer); buffer = ''; pieces.push(atPiece(hit)) }
        cursor = at + 1 + token.length
        continue
      }
    }
    // 3. nothing: leave it as the text it is, and say so when it looked like a target
    const loose = LOOSE_TOKEN.exec(rest)?.[0] ?? ''
    const before = source.slice(0, at)
    if (loose && !loose.includes('.') && !loose.includes('/') && !EMAIL_BEFORE.test(before)) missing.push(loose)
    buffer += '@'
    cursor = at + 1
  }
  flush(buffer)
  return { pieces, missing }
}

function atPiece(candidate: MentionCandidate): MentionPiece {
  const name = (candidate.name ?? '').trim()
  return name ? { type: 'at', id: candidate.id, name } : { type: 'at', id: candidate.id }
}

/** What one outgoing part looks like once an @ is written into it. */
export interface OutgoingPart {
  type: string
  text?: string
  userId?: string
  name?: string
}

/**
 * The body of one message, in the shape the platform that will send it takes.
 *
 * The two platforms want an @ in two different forms, and which one applies is a property of the
 * *platform*, never of the wording: the official bot has to carry it as QQ's own markup inside the
 * body (`atMarkup`, qq.ts — a separate `<qq:markdown>` element per text run would lose the blank
 * line after our quote line, and markup sitting before the first markdown element comes back
 * escapeMarkdown'd), while the userbot takes a Satori `at` element. `markdown` only says whether
 * the *text* goes out as markdown, and the agent may override it either way, so it must not decide
 * this.
 *
 * A mention also forces markdown on the official bot, whatever the agent asked for: QQ parses
 * `<qqbot-at-user …>` only in a markdown message — the same markup in a plain-text message
 * (msg_type 0) reaches the group as the literal string. Measured against the live group, see
 * atMarkup in qq.ts.
 *
 * `quoteLine` is our own `> 名字：…` blockquote line (the official bot's stand-in for QQ's native
 * quote, which it drops on markdown messages): it has to start the body, so it is written first
 * and the mentions follow it. The userbot keeps a native quote part and passes no line here.
 */
export function mentionBody(pieces: MentionPiece[], opts: { platform: string, markdown?: boolean, quoteLine?: string }): OutgoingPart[] {
  if (opts.platform !== 'qq') {
    return pieces.map((piece) => piece.type === 'at'
      ? { type: 'at', userId: piece.id, ...(piece.name ? { name: piece.name } : {}) }
      : { type: 'text', text: piece.text })
  }
  const hasMention = pieces.some((piece) => piece.type === 'at')
  const mark = (piece: MentionPiece) => piece.type === 'at' ? atMarkup(piece.id) : piece.text
  const text = (opts.quoteLine ? `${opts.quoteLine}\n\n` : '') + pieces.map(mark).join('')
  if (!text) return []
  return [{ type: hasMention || opts.markdown !== false ? 'markdown' : 'text', text }]
}

/** The same pieces with the mentions written out as a person would see them (`@名字`). */
export function readableMentions(pieces: MentionPiece[]): string {
  return pieces.map((piece) => piece.type === 'at' ? `@${piece.name ?? piece.id}` : piece.text).join('')
}
