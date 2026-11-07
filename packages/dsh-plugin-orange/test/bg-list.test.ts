/**
 * `/ai.bg` must list every task that is still alive — including the ones that are
 * asleep between wake-ups. A long task's worker ends its turn while it waits (a
 * timer, a sleeping background job), so its agent sits at "idle" for hours; the
 * old report only looked at agents whose status was "running" and therefore hid
 * exactly those tasks (the reported symptom: a reminder task due in two days was
 * missing from `/ai.bg` while short tasks showed up).
 *
 * No dsh, no network: a stub ctx, the real SQLite store in a temp dir.
 *
 * Local: node --experimental-transform-types test/bg-list.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrangeBot } from '../src/bot.ts'

const agents: any[] = []
const ctx: any = { agents: { list: () => agents, isOwnedBy: () => false, get: () => undefined } }
const config: any = {
  dataDir: mkdtempSync(join(tmpdir(), 'orange-bglist-')),
  workspace: '/tmp',
  koishi: { endpoint: 'http://127.0.0.1:9/satori', token: 'x' },
  crossgram: { endpoint: 'http://127.0.0.1:9/satori', token: 'x' },
  llm: { baseURL: 'http://127.0.0.1:9', apiKey: 'x', model: 'm', provider: 'p', agentModel: 'm' },
  admins: [], errorGroup: '', agentPreset: 'orange',
}
const bot: any = new OrangeBot(ctx, config)
const GROUP = 'cg:1'
const OTHER = 'cg:2'

let checks = 0
const ok = (what: string, fn: () => void) => { fn(); checks++; console.log(`PASS ${what}`) }

/** A task row whose heartbeat is `ago` ms old (task_update writes it). */
function task(conv: string, title: string, sessionId: string, status = 'running', ago = 0): number {
  const id = bot.store.createTask({ conv, title, kind: 'research', sessionId })
  bot.store.updateTask(id, { status })
  if (ago) bot.store.db.prepare('UPDATE tasks SET updated = ?, created = ? WHERE id = ?').run(Date.now() - ago, Date.now() - ago, id)
  return id
}

const HOUR = 3600_000

// --- 1. the reported bug: a long task waiting between wake-ups must show up ------
// Its worker ended its turn hours ago (that is how a timer wait looks from dsh),
// so the live agent is idle — but the task is very much still running.
const sleeping = task(GROUP, '2026-10-19 00:00 提醒群友睡觉', 'orange-task-sleep', 'waiting', 4 * HOUR)
agents.push({ status: 'idle', session: { id: 'orange-task-sleep' } })

ok('a task waiting between wake-ups is listed', () => {
  const text = bot.backgroundReport(GROUP)
  console.log(text)
  assert.match(text, new RegExp(`#${sleeping} 2026-10-19`), '/ai.bg must not hide a sleeping long task')
  assert.match(text, /等待中/, 'and it must say it is waiting, not pretend it is executing')
  assert.match(text, /最后心跳 4小时前/, 'the heartbeat is what shows it is still alive')
})

// --- 2. a task the worker never updated is still alive too -----------------------
const stale = task(GROUP, 'worker 忘了 task_update', 'orange-task-stale', 'running', 2 * HOUR)
ok('a task left on "running" without a live agent is listed', () => {
  const text = bot.backgroundReport(GROUP)
  assert.match(text, new RegExp(`#${stale} worker`))
  assert.match(text, /未在执行 · 最后心跳 2小时前/, 'a stale row is not sold as executing')
})

// --- 2b. the second sighting (2026-10-18): two running tasks, workers not live --
// In the group `/ai.bg` answered "本群现在没有后台任务在跑" while two tasks were
// genuinely running. Both rows say "running"; neither worker was in a turn at the
// moment of the report (they were between steps / waiting on their own job).
const tower = task(GROUP, '爬塔 v2', 'orange-task-tower', 'running', 30 * 60_000)
const debug = task(GROUP, '草莓酱排障', 'orange-task-strawberry', 'running', 30 * 60_000)
ok('two running tasks with no live worker are both listed', () => {
  const text = bot.backgroundReport(GROUP)
  assert.notEqual(text, '本群现在没有后台任务在跑')
  assert.ok(text.includes(`#${tower} 爬塔 v2`), 'the first task must be listed')
  assert.ok(text.includes(`#${debug} 草莓酱排障`), 'the second task must be listed')
})

// --- 3. a live task keeps its precise "已跑" and is not listed twice -------------
agents.push({ status: 'running', session: { id: 'orange-task-live' } })
const live = task(GROUP, '正在跑的任务', 'orange-task-live', 'running', HOUR)
bot.noteAgentStatus('orange-task-live', 'running')
ok('a live task is listed once, with how long it has been running', () => {
  const text = bot.backgroundReport(GROUP)
  assert.equal(text.split(`#${live} `).length - 1, 1, 'exactly one line for the live task')
  assert.match(text, new RegExp(`#${live} [^\\n]*\\n  已跑`))
})

// --- 4. finished tasks stay out of the report ------------------------------------
const done = task(GROUP, '已经做完的任务', 'orange-task-done', 'done')
ok('a done task is not listed', () => {
  assert.ok(!bot.backgroundReport(GROUP).includes(`#${done} `))
})

// --- 5. the group's report is still scoped to that group -------------------------
const elsewhere = task(OTHER, '别的群的任务', 'orange-task-other', 'waiting', HOUR)
ok('another group\'s task stays out of this group\'s report', () => {
  assert.ok(!bot.backgroundReport(GROUP).includes(`#${elsewhere} `))
})
ok('the private (global) report names the group each task came from', () => {
  const text = bot.backgroundReport()
  assert.ok(text.includes(`#${elsewhere} 别的群的任务`))
  assert.match(text, /来自 cg:/)
})

// --- 6. nothing alive: the old short answer keeps working ------------------------
ok('an empty board still says so', () => {
  agents.length = 0 // the workers have exited their turns
  for (const id of [sleeping, stale, tower, debug, live, done, elsewhere]) bot.store.updateTask(id, { status: 'done' })
  assert.equal(bot.backgroundReport(GROUP), '本群现在没有后台任务在跑')
})

console.log(`\n${checks} checks passed`)
