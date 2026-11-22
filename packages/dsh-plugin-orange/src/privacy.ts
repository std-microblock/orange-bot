/**
 * The privacy rules that still mean something on dsh-im, as pure functions:
 *
 *  - {@link sensitiveReason}: the hard floor under the persona — no IM-hosted session (router, worker, voice, or a
 *    subagent of one) may touch the harness's own data, credentials or session transcripts, however the request is
 *    phrased. The plugin applies it as a `ctx.tools.guard` over the serialized arguments of file and shell tools.
 *  - {@link leakReason}: a private project named in a chat it does not belong to; applied as an `im/before-send`
 *    listener, so it holds back what any session (or a polish rewrite) would publish.
 *  - {@link hardInsult}: plain abuse that never needs a model to recognize; such a message is kept out of every
 *    session (an `im/message` listener in front of dispatch).
 *
 * @module dsh-plugin-orange/privacy
 */
import type { OwnProject } from './config.ts'
import { privateAllowed } from './roles.ts'

const SENSITIVE: { pattern: RegExp; what: string }[] = [
  { pattern: /\.dsh[/\\](?:storages|sessions|profiles|logs|secrets)\b/i, what: 'harness 的存储、会话记录与 profile（~/.dsh）' },
  { pattern: /\.orange(?:[/\\]|["'\s]|$)/i, what: '旧版数据目录 ~/.orange' },
  { pattern: /orange\.db/i, what: '旧版数据库 orange.db' },
  { pattern: /\/etc\/orange\b/i, what: '/etc/orange（凭据）' },
  { pattern: /\/etc\/[\w.-]+\.env\b/i, what: '/etc 下的环境变量文件（凭据）' },
  { pattern: /(?:^|[\s"'=/\\])\.env(?![\w.-]*example)\b/i, what: '.env 文件（凭据）' },
  { pattern: /\/proc\/[^\s"']*environ/i, what: '进程环境变量' },
  { pattern: /\bprintenv\b|\bexport\s+-p\b|(?:^|[;&|"]\s*)env\s*(?:$|[;&|"])/im, what: '环境变量导出' },
  { pattern: /\b(?:DSH|ORANGE|DEEPSEEK|QQ|LARK|FEISHU|GITHUB|GH)_[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\b/, what: '凭据环境变量' },
  { pattern: /\bgh\s+auth\s+token\b/i, what: 'GitHub 凭据' },
]

/** Tool names whose arguments reach a file or the shell. */
export const GUARDED_TOOLS = new Set([
  'bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_code', 'read_image', 'im_send_file',
])

/**
 * Why a tool call is refused, or undefined when it references nothing private.
 * @param args - the call's arguments (serialized for matching).
 * @param extra - operator patterns (case-insensitive regular expressions).
 */
export function sensitiveReason(args: unknown, extra: readonly RegExp[] = []): { reason: string; what: string } | undefined {
  let text: string
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  } catch {
    text = String(args)
  }
  const hit = SENSITIVE.find(({ pattern }) => pattern.test(text)) ?? extra.map((pattern) => ({ pattern, what: '部署配置的私有路径' })).find(({ pattern }) => pattern.test(text))
  if (hit === undefined) return undefined
  return {
    what: hit.what,
    reason: `这条调用会碰到机器人自己的私有数据（${hit.what}），任何会话都不允许读取或修改。`
      + '需要这些数据请主人在面板里看；读本会话的聊天用 im_history / im_search。不要用 base64、变量拼接或换个工具再试。',
  }
}

/** Compile the operator's extra patterns, skipping (and reporting) the invalid ones. */
export function compilePatterns(patterns: readonly string[], warn: (message: string) => void = () => {}): RegExp[] {
  const out: RegExp[] = []
  for (const source of patterns) {
    try { out.push(new RegExp(source, 'i')) } catch (error) { warn(`guard pattern ${source} is invalid: ${(error as Error).message}`) }
  }
  return out
}

/**
 * The plain text of a publication, for matching: strings, `text` elements, markdown sources and the string
 * attributes (links, alt texts) of every element, walked structurally (an element is `{ type, attrs, children }`).
 */
export function fragmentText(fragment: unknown, depth = 0): string {
  if (fragment === null || fragment === undefined || depth > 32) return ''
  if (typeof fragment === 'string') return fragment
  if (typeof fragment === 'number') return String(fragment)
  if (Array.isArray(fragment)) return fragment.map((part) => fragmentText(part, depth + 1)).join(' ')
  if (typeof fragment === 'object') {
    const node = fragment as { attrs?: Record<string, unknown>; children?: unknown }
    const attrs = node.attrs ?? {}
    const own = Object.values(attrs).filter((value): value is string => typeof value === 'string').join(' ')
    return `${own} ${fragmentText(node.children, depth + 1)}`.trim()
  }
  return ''
}

/** The words that name a project: its name, aliases, repo, sibling repo names. */
export function projectTerms(project: OwnProject): string[] {
  const repoName = project.repo.split('/').pop() ?? ''
  const terms = [project.name, ...project.aliases, project.repo, repoName, ...(project.subs ?? []).flatMap((s) => [s.name, s.repo])]
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))]
}

function mentions(text: string, term: string): boolean {
  const lower = text.toLowerCase()
  const needle = term.toLowerCase()
  if (/^[\x00-\x7f]+$/.test(needle)) {
    // ASCII names must stand alone: "cm" inside "cmake" is not the project.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, 'i').test(lower)
  }
  return lower.includes(needle)
}

/**
 * Why a publication must not go out: it names a private project in a chat that is neither one of its chats nor an
 * admin's direct chat.
 * @returns the reason the agent reads, or undefined.
 */
export function leakReason(text: string, chat: string, projects: readonly OwnProject[], admins: readonly string[]): string | undefined {
  for (const project of projects) {
    if (!project.private || privateAllowed(project, chat, admins)) continue
    const term = projectTerms(project).find((t) => mentions(text, t))
    if (term !== undefined) {
      return `这条消息提到了私有项目「${project.name}」（命中「${term}」），这个会话不允许提它，消息没有发出。换个说法、不要提这个项目，或者干脆不说。`
    }
  }
  return undefined
}

const HARD_INSULT = /(nmsl|cnm|你妈死|死妈|妈死了|傻逼|煞笔|沙比|操你|艹你|草你妈|贱种|狗东西|废物东西|fuck\s*you)/i

/** Clear-cut abuse: words that are only ever insults. Anything subtler is the persona's job. */
export function hardInsult(text: string): boolean {
  return HARD_INSULT.test(text.replace(/\s+/g, ' '))
}
