/**
 * GitHub follow-ups: poll the notifications of the `gh` login the host is signed in with, and hand new comments,
 * reviews and review comments on a PR or issue a task worker linked (`task_link`) to that worker as a steer.
 *
 * @module dsh-plugin-orange/github
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OrangeStore } from './store.ts'

const run = promisify(execFile)

export type Gh = <T = unknown>(args: string[]) => Promise<T>

/** `gh <args>` with JSON output. */
export const gh: Gh = async <T>(args: string[]): Promise<T> => {
  const { stdout } = await run('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 })
  return (stdout.trim() ? JSON.parse(stdout) : undefined) as T
}

export interface Feedback {
  at: string
  who: string
  body: string
  where: 'comment' | 'review' | 'review comment'
}

interface GhComment { created_at: string; user?: { login?: string }; body?: string; path?: string; line?: number; original_line?: number }
interface GhReview { submitted_at?: string; user?: { login?: string }; body?: string; state?: string }

/** New feedback since `since`, oldest first, the bot's own excluded. */
export function freshFeedback(input: { comments: GhComment[]; reviews: GhReview[]; reviewComments: GhComment[]; since: string; me?: string }): Feedback[] {
  const out: Feedback[] = [
    ...input.comments.map((c) => ({ at: c.created_at, who: c.user?.login ?? '?', body: c.body ?? '', where: 'comment' as const })),
    ...input.reviews.filter((r) => r.submitted_at !== undefined && r.body).map((r) => ({ at: r.submitted_at!, who: r.user?.login ?? '?', body: `[${r.state ?? ''}] ${r.body}`, where: 'review' as const })),
    ...input.reviewComments.map((c) => ({ at: c.created_at, who: c.user?.login ?? '?', body: `${c.path ?? ''}:${c.line ?? c.original_line ?? ''} ${c.body ?? ''}`, where: 'review comment' as const })),
  ]
  return out.filter((c) => c.who !== input.me && c.at > input.since).sort((a, b) => a.at.localeCompare(b.at))
}

export function feedbackText(repo: string, number: string, feedback: readonly Feedback[]): string {
  return `GitHub 上 ${repo}#${number} 有新的反馈：\n${feedback.map((c) => `- ${c.who}（${c.where}，${c.at}）：${c.body}`).join('\n')}\n\n`
    + '是修改要求就在原分支上改完 push，并在 GitHub 上简短回复；需要告诉群里时简短说一句。'
}

export interface PollerDeps {
  store: OrangeStore
  /** Steer text into the worker of a task; false when the task is gone. */
  deliver: (task: number, session: string, text: string, id: string) => Promise<boolean>
  log: { info(message: string): void; warn(message: string): void }
  gh?: Gh
  now?: () => number
}

/** One poll: returns how many tasks received feedback. */
export async function pollOnce(deps: PollerDeps, me: string | undefined): Promise<number> {
  const call = deps.gh ?? gh
  const now = new Date((deps.now ?? Date.now)()).toISOString()
  const since = deps.store.state('gh:since') ?? new Date(Date.parse(now) - 86400_000).toISOString()
  const notes = await call<{ repository?: { full_name?: string }; subject?: { url?: string; type?: string } }[]>(
    ['api', `notifications?all=false&participating=true&since=${encodeURIComponent(since)}`],
  )
  let delivered = 0
  for (const note of notes ?? []) {
    const repo = note.repository?.full_name ?? ''
    const number = (note.subject?.url ?? '').split('/').pop() ?? ''
    const link = deps.store.linkOf(repo, number)
    if (link === undefined) continue
    const pulls = note.subject?.type === 'PullRequest'
    const lastSeen = link.seen ?? new Date(link.at).toISOString()
    const comments = await call<GhComment[]>(['api', `repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(lastSeen)}`]).catch(() => [])
    const reviews = pulls ? await call<GhReview[]>(['api', `repos/${repo}/pulls/${number}/reviews`]).catch(() => []) : []
    const reviewComments = pulls ? await call<GhComment[]>(['api', `repos/${repo}/pulls/${number}/comments?since=${encodeURIComponent(lastSeen)}`]).catch(() => []) : []
    const fresh = freshFeedback({ comments: comments ?? [], reviews: reviews ?? [], reviewComments: reviewComments ?? [], since: lastSeen, ...me ? { me } : {} })
    await deps.store.markSeen(repo, number, now)
    if (fresh.length === 0) continue
    const ok = await deps.deliver(link.task, link.session, feedbackText(repo, number, fresh), `gh:${repo}#${number}@${now}`)
    if (ok) delivered += 1
    else deps.log.warn(`github: task #${link.task} for ${repo}#${number} is gone; feedback dropped`)
  }
  await deps.store.setState('gh:since', now)
  await call(['api', '-X', 'PUT', 'notifications', '-f', `last_read_at=${now}`]).catch(() => undefined)
  return delivered
}

/** Start the poller; returns its stopper. */
export function startPoller(deps: PollerDeps, intervalMs: number): () => void {
  const call = deps.gh ?? gh
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let me: string | undefined
  let failures = 0
  const schedule = (ms: number) => { if (!stopped) timer = setTimeout(() => { void tick() }, ms) }
  const tick = async () => {
    try {
      const authed = await run('gh', ['auth', 'status'], { timeout: 30_000 }).then(() => true, () => false)
      if (!authed) { schedule(intervalMs * 5); return }
      me ??= (await call<{ login: string }>(['api', 'user'])).login
      const n = await pollOnce(deps, me)
      if (n > 0) deps.log.info(`github: feedback handed to ${n} task(s)`)
      failures = 0
    } catch (error) {
      failures += 1
      if (failures % 5 === 0) deps.log.warn(`github notifications failed ${failures} times in a row: ${(error as Error).message}`)
    }
    schedule(intervalMs)
  }
  schedule(30_000)
  return () => { stopped = true; clearTimeout(timer) }
}
