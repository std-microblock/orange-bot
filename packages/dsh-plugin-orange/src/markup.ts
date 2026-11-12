/**
 * The little markup the plugins write into a stored message: `<forward id="1" …>…</forward>`,
 * `<quote>…</quote>` and attachment placeholders (`[图片 #12]`, `[文件 #13 log.zip]`).
 *
 * It has to be scanned, not matched with a regex. A merged forward **nests** (`<forward id="1">`
 * containing `<forward id="1.1">`), and a non-greedy `/<forward[\s\S]*?<\/forward>/` stops at the
 * *inner* closing tag: the outer block comes out cut in half and the rest leaks into the page as
 * raw markup (`</forward>` and the rest of the message) — that is what the panel used to draw for a
 * nested forward. Here a block is
 * found by counting its tags, so nesting is exact at any depth.
 *
 * This text is written for the model, so it must not be shown to a person as it stands: the same
 * module carries the other direction — `humanText()` below turns it back into one line somebody can
 * read (a reply's quote in the panel, the blockquote line QQ gets instead of a native reply).
 */

/** One run of text, or one balanced `<tag …>…</tag>` block with its content already split up. */
export type MarkupPart =
  | { type: 'text', text: string }
  | { type: 'block', tag: string, attrs: Record<string, string>, body: string, parts: MarkupPart[] }

const DEFAULT_TAGS = ['forward', 'quote']

/** The attributes of an opening tag: `id="1" title="群聊的聊天记录"` -> `{ id: '1', … }`. */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of source.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g)) attrs[match[1]] = match[2]
  for (const match of source.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*'([^']*)'/g)) attrs[match[1]] = match[2]
  return attrs
}

/** Where an opening tag ends: the first `>` that is not inside a quoted attribute value. */
function endOfOpenTag(text: string, from: number): number {
  let quote: string | undefined
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (quote) { if (char === quote) quote = undefined; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '>') return i
  }
  return -1
}

/** `<forward` at `at` (and not `<forwardx`) counts as that tag opening. */
function openingAt(source: string, at: number, tags: string[]): string | undefined {
  if (source[at] !== '<') return undefined
  for (const tag of tags) {
    if (!source.startsWith(`<${tag}`, at)) continue
    const next = source[at + tag.length + 1]
    if (next === undefined || next === '>' || /\s/.test(next)) return tag
  }
  return undefined
}

/** The index of the `</tag>` closing the block that starts at `from`, counting nested opens. */
function matchingClose(source: string, from: number, tag: string, tags: string[]): number {
  const closeToken = `</${tag}>`
  let depth = 1
  let cursor = from
  while (cursor < source.length) {
    const open = source.indexOf(`<${tag}`, cursor)
    const close = source.indexOf(closeToken, cursor)
    if (close < 0) return -1
    if (open >= 0 && open < close && openingAt(source, open, [tag]) !== undefined) {
      depth++
      cursor = open + tag.length + 1
      continue
    }
    depth--
    if (depth === 0) return close
    cursor = close + closeToken.length
  }
  return -1
}

/**
 * Split a message into text runs and blocks. A block left unclosed runs to the end of the text (so
 * nothing is lost), and a stray closing tag is dropped: it is markup, not something anyone typed.
 */
export function splitMarkup(text: string, tags: string[] = DEFAULT_TAGS): MarkupPart[] {
  const parts: MarkupPart[] = []
  const source = String(text ?? '')
  let cursor = 0
  let buffer = ''
  const flush = () => { if (buffer) { parts.push({ type: 'text', text: buffer }); buffer = '' } }
  while (cursor < source.length) {
    const tag = openingAt(source, cursor, tags)
    if (tag) {
      const attrsEnd = cursor + tag.length + 1
      const openEnd = endOfOpenTag(source, attrsEnd)
      if (openEnd < 0) { buffer += source.slice(cursor); break }
      const close = matchingClose(source, openEnd + 1, tag, tags)
      const bodyEnd = close < 0 ? source.length : close
      const body = source.slice(openEnd + 1, bodyEnd)
      flush()
      parts.push({ type: 'block', tag, attrs: parseAttrs(source.slice(attrsEnd, openEnd)), body, parts: splitMarkup(body, tags) })
      cursor = close < 0 ? source.length : close + tag.length + 3
      continue
    }
    const stray = tags.find((name) => source.startsWith(`</${name}>`, cursor))
    if (stray) { cursor += stray.length + 3; continue }
    buffer += source[cursor++]
  }
  flush()
  return parts
}

/** The same text with every block of those tags taken out (used to compare two platforms' texts). */
export function stripMarkup(text: string, tags: string[] = DEFAULT_TAGS): string {
  return splitMarkup(text, tags).map((part) => part.type === 'text' ? part.text : ' ').join('')
}

/**
 * Where an attachment sat, in both shapes we have written over time: `[图片 #12]` / `[文件 #13 log.zip]`
 * (an id, see media.ts) and the older `[图片#1]` (a position inside one message).
 */
const PLACEHOLDER = /\[(图片|表情|文件|视频|语音|音频)\s?#\d+(?:\s+([^\]\n]{0,80}?))?\]/g
const PLACEHOLDER_LABEL: Record<string, string> = { 图片: '图片', 表情: '表情', 文件: '文件', 视频: '视频', 语音: '语音', 音频: '语音' }

/**
 * The element syntax a person should never see in a preview: our own blocks, the `attachment…`
 * serialization koishi hands over with a quoted body (see renderQuote in satori.ts), and the plain
 * Satori element names. Names only — `<https://a>` or a nickname like `<&ÿÿÏP>` is somebody's text
 * and stays.
 */
const ELEMENT = String.raw`(?:quote|forward|attachment\w*|at|br|button|button-group|emoji|face|file|image|img|markdown|member|qq|video|audio)`
/** A complete element. */
const TAG = new RegExp(String.raw`</?${ELEMENT}\b[^>\n]{0,400}>`, 'gi')
/**
 * An element cut in half by truncation. `renderQuote` clips a quoted body at 120 chars, and the
 * quote line we write ourselves (`> 名字：…`, see quoteBlockquote in qq.ts) clips its snippet at 42 —
 * so `…</quote` / `<forward id="1" title="星河远岸和Voidsd的聊天记录" c…` with no `>` are real strings
 * in the database. A loose `<` followed by the end of its line is one of those.
 */
const CUT_TAG = new RegExp(String.raw`</?${ELEMENT}\b[^>\n]{0,400}(?=\n|$)`, 'gi')
/** The same, but only for the one element that carries information worth keeping. */
const CUT_FORWARD = /<\/?forward\b[^>\n]{0,400}(?=\n|$)/gi

/** Stored text with the element debris taken out of it. */
export function stripStrayTags(text: unknown): string {
  return String(text ?? '')
    .replace(TAG, '')
    // a bundle that got clipped mid-tag still names itself in `title="…"`: show the same
    // `[群聊的聊天记录]` a freshly rendered line would, instead of dropping it entirely
    .replace(CUT_FORWARD, (fragment: string) => {
      const title = /\btitle\s*=\s*"([^"]*)"/.exec(fragment)
      return title?.[1]?.trim() ? `[${title[1].trim()}]` : ''
    })
    .replace(CUT_TAG, '')
}

/**
 * What a person should read where the model reads markup. Our stored text describes a message with
 * `<quote>`/`<forward>` blocks and attachment placeholders — perfect for the agent, raw XML on
 * screen, which is what the panel's quote row and QQ's `> 名字：…` reply line used to paste.
 *
 *   `<quote>蔚敏电阻：搞不定喵</quote> 看下这个`  ->  `蔚敏电阻：搞不定喵 看下这个`
 *   `<forward id="1" title="群聊的聊天记录">…</forward>`  ->  `[群聊的聊天记录]` (QQ draws a bundle
 *   as one bubble with a title, so the contents are somebody else's chat log, not this line's text)
 *   `[图片 #12]` / `[文件 #13 log.zip]`  ->  `[图片]` / `[文件 log.zip]`
 *
 * Line breaks and spacing are left alone, so a whole message keeps its shape.
 */
export function plainText(text: unknown): string {
  const walk = (parts: MarkupPart[]): string => parts.map((part) => {
    if (part.type === 'block') {
      if (part.tag === 'forward') return `[${String(part.attrs.title ?? '').trim() || '聊天记录'}]`
      // a quote is other people's words quoted again: what it said, without its own tags
      return walk(part.parts)
    }
    return stripStrayTags(part.text).replace(PLACEHOLDER, (_match, kind: string, name?: string) =>
      name?.trim() ? `[${PLACEHOLDER_LABEL[kind] ?? kind} ${name.trim()}]` : `[${PLACEHOLDER_LABEL[kind] ?? kind}]`)
  }).join('')
  return walk(splitMarkup(String(text ?? '')))
}

/**
 * The one-line version of the above, for the places that show a *preview* of somebody else's words
 * (a reply's quote row, QQ's blockquote line, a conversation's last message). `maxChars` clips the
 * result (`0` = no clip).
 */
export function humanText(text: unknown, maxChars = 0): string {
  const flat = plainText(text).replace(/\s+/g, ' ').trim()
  return maxChars > 0 && flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
}
