/**
 * The repeat guard: one answer must not reach the same conversation twice.
 *
 * Measured on 2026-10-17 in the paired group (`qq:1A5CBACE…` / `cg:550358997`): 00:29 and 00:30
 * the group got the same Firefox answer twice, worded slightly differently by the style rewrite
 * (`扩展列表就在 profile 的 extensions.json 里（jq 一行就能导出）…` / `…在 profile 的
 * extensions.json 里~ jq 一行就能导出来…`). Two different wordings mean two `say` calls — the
 * rewrite draws its sub-styles per send — so this is not the QQ rendering quirk of 2026-10-10
 * (that one draws *one* message's body twice, same words). The first of the two left **no** row on
 * the official side although the group had it: `OrangeBot.send` only records after the bridge
 * answered with message ids, so a call that fails (or times out) after the platform already
 * accepted the message is invisible — and the agent that sees the error repeats its answer.
 *
 * The guard therefore counts an answer from the moment it is handed to the bridge, whether or not
 * a row follows, and every caller of `send` shares it: the chat session, a background task worker
 * and the panel. It is deliberately narrow — a whole answer, close to identical, in the same
 * conversation — because that is the shape of the accident; a short line ("哈哈", "?") and a
 * genuinely different message still go out, and so does an answer to a different conversation.
 */
import { pairText } from './pairing.ts'

/** Shortest normalized answer the guard weighs: below this, people repeat each other all day. */
export const REPEAT_MIN_CHARS = 12

/** How close two normalized answers must be to count as one answer worded twice. */
export const REPEAT_SIMILARITY = 0.82

/** How long an answer that went out keeps protecting its conversation from its own retry. */
export const REPEAT_WINDOW_MS = 3 * 60_000

/**
 * What one answer reduces to for the comparison: `pairText` drops the quotes, @-mentions, media
 * placeholders, whitespace and punctuation, so a mention added or dropped by a rewrite, an
 * attachment that moved to its own message, and the odd comma cannot hide a repeat.
 */
export function answerKey(text: string): string {
  return pairText(String(text ?? ''))
}

/** Sørensen–Dice over character bigrams: 0 for no overlap, 1 for the same characters in order. */
export function answerSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (text: string): Map<string, number> => {
    const out = new Map<string, number>()
    for (let i = 0; i + 1 < text.length; i++) {
      const gram = text.slice(i, i + 2)
      out.set(gram, (out.get(gram) ?? 0) + 1)
    }
    return out
  }
  const left = grams(a)
  const right = grams(b)
  let shared = 0
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0)
  const total = (a.length - 1) + (b.length - 1)
  return total > 0 ? (2 * shared) / total : 0
}

/** Whether two normalized answers are one answer: long enough, and worded practically the same. */
export function sameAnswer(a: string, b: string): boolean {
  const x = answerKey(a)
  const y = answerKey(b)
  if (x.length < REPEAT_MIN_CHARS || y.length < REPEAT_MIN_CHARS) return false
  return answerSimilarity(x, y) >= REPEAT_SIMILARITY
}

/**
 * What the agent is told when it tries to repeat itself — the wording matters, because the usual
 * reason is an error it just saw: the send that reported the failure may well be in the group.
 */
export function repeatSendError(secondsAgo: number): string {
  const ago = secondsAgo < 90 ? `${Math.max(1, secondsAgo)} 秒前` : `${Math.round(secondsAgo / 60)} 分钟前`
  return `这条已经发过了（${ago}，一样的意思），群里看到的就是它——别重发。刚才那次报错/超时的那条，多半就是这个已经出去的消息：不要用同一句话再试一次，去看一眼 chat_history 或说点新东西；没什么要补的就别说话。`
}

/**
 * The retry wording for a send that *failed*: on this bridge a failure does not mean the message
 * did not go out (see the top of this file), so the error the agent reads has to say so. Without it
 * the agent does the obvious thing — calls `say` again with the same sentence — and that is half of
 * how the 2026-10-17 repeat happened; the guard then refuses the retry, and this wording is what
 * keeps the agent from treating that refusal as a problem to work around.
 */
export function sendUnknownError(): string {
  return '结果未知：这条可能已经发出去了。别原样重发同一句话——先看一眼 chat_history 确认群里有没有，或者干脆说点别的；3 分钟内的重复回答会被直接拦下。'
}
