import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config } from '../src/config.ts'
import { feedbackText, freshFeedback, pollOnce } from '../src/github.ts'
import { importV1 } from '../src/import-v1.ts'
import { CHAT_PERSONA, personaSection, TASK_PERSONA } from '../src/persona.ts'
import { fragmentText, hardInsult, leakReason, sensitiveReason } from '../src/privacy.ts'
import { effective, homeChat, isAdmin, privateAllowed, projectsFor, roleOf } from '../src/roles.ts'
import { memoryTables, normalizeScope, OrangeStore, visibleScope } from '../src/store.ts'
import { usageOf } from '../src/usage.ts'

const BOT = 'qq:1000'
const GROUP = `${BOT}|group:G1`
const OTHER = `${BOT}|group:G2`
const ADMIN_DM = `${BOT}|user:U-admin`

const config = Config.parse({
  admins: ['M-admin', 'U-admin'],
  owner: { name: '测试主人', github: 'someone' },
  projects: [
    { name: 'Alpha', aliases: ['alp'], repo: 'someone/alpha', note: 'public project' },
    { name: 'Secret', aliases: ['sekrit'], repo: 'someone/secret-tool', private: true, chats: [GROUP] },
  ],
})

test('store: memory scopes stay in their chat', async () => {
  const store = new OrangeStore(memoryTables())
  await store.addMemory(`chat:${GROUP}`, 'G1 聊蔚蓝')
  await store.addMemory(`chat:${OTHER}`, 'G2 的秘密')
  await store.addMemory('global', '全局事实')
  await store.addMemory('user:U1', '他写 mod')
  const seen = store.memories({ chat: GROUP }).map((r) => r.text)
  assert.deepEqual(new Set(seen), new Set(['G1 聊蔚蓝', '全局事实', '他写 mod']))
  assert.equal(store.memories({ chat: GROUP, all: true }).length, 4)
  assert.deepEqual(store.memories({ chat: GROUP, query: 'mod' }).map((r) => r.text), ['他写 mod'])
  // duplicates are not stored twice; ids keep counting after a reload
  const again = await store.addMemory('global', '全局事实')
  assert.equal(store.memories({ all: true }).length, 4)
  const reloaded = new OrangeStore(store.tables)
  const next = await reloaded.addMemory('global', '新的')
  assert.ok(next.id > again.id)
  assert.deepEqual(store.promptFacts(GROUP, 10).map((r) => r.scope), [`chat:${GROUP}`, 'global', 'global'])
  assert.equal(store.promptFacts(GROUP, 1).length, 1)
})

test('store: scope normalization and visibility', () => {
  assert.equal(normalizeScope(undefined, GROUP), `chat:${GROUP}`)
  assert.equal(normalizeScope('group:x', GROUP), 'chat:x')
  assert.equal(normalizeScope('user:abc', GROUP), 'user:abc')
  assert.equal(normalizeScope('CeleMod', GROUP), 'project:CeleMod')
  assert.equal(visibleScope(`chat:${OTHER}`, GROUP, false), false)
  assert.equal(visibleScope(`chat:${OTHER}`, GROUP, true), true)
})

test('store: users, tags, usage, links', async () => {
  const store = new OrangeStore(memoryTables(), () => Date.parse('2026-11-20T10:00:00Z'))
  await store.seen('U1', '小明', GROUP)
  await store.setUserTag('U1', 'dev', true)
  await store.seen('U1', '小明', GROUP)
  assert.deepEqual(store.user('U1')?.tags, ['dev'])
  await assert.rejects(store.setUserTag('U1', 'god', true))
  await store.addUsage({ kind: 'router', model: 'm', input: 10, cached: 5, output: 2 })
  await store.addUsage({ kind: 'router', model: 'm', input: 1, cached: 0, output: 1 })
  assert.deepEqual(store.usage(), [{ day: '2026-11-20', kind: 'router', model: 'm', calls: 2, input: 11, cached: 5, output: 3 }])
  await store.link({ repo: 'a/b', number: '7', kind: 'pr', task: 3, session: 's' })
  assert.equal(store.linkOf('a/b', '7')?.task, 3)
})

test('roles: sessions are classified from their records', () => {
  assert.equal(roleOf({ key: `dispatch:chat:${GROUP}`, owner: 'dispatch', sessionId: 'a', bindings: [] }), 'router')
  assert.equal(roleOf({ key: 'task:3', owner: 'session-tasks', sessionId: 'b', bindings: [] }), 'worker')
  assert.equal(roleOf({ key: 'orange-voice:main', owner: 'orange-voice', sessionId: 'c', bindings: [] }), 'voice')
  assert.equal(homeChat({ key: 'x', owner: 'y', sessionId: 'z', bindings: [{ chat: OTHER, writable: false }, { chat: GROUP, writable: true, home: true }] }), GROUP)
  assert.ok(isAdmin(['M-admin'], 'M-admin'))
  assert.ok(isAdmin([`${BOT}|M-admin`], 'M-admin', BOT))
  assert.ok(!isAdmin([`${BOT}|M-admin`], 'M-admin', 'qq:2000'))
})

test('roles: private projects only where they belong', () => {
  const settings = effective(config, undefined)
  const secret = settings.projects[1]!
  assert.ok(privateAllowed(secret, GROUP, settings.admins))
  assert.ok(privateAllowed(secret, ADMIN_DM, settings.admins))
  assert.ok(!privateAllowed(secret, OTHER, settings.admins))
  assert.ok(!privateAllowed(secret, `${BOT}|user:stranger`, settings.admins))
  assert.deepEqual(projectsFor(settings, OTHER).map((p) => p.name), ['Alpha'])
  assert.deepEqual(projectsFor(settings, GROUP).map((p) => p.name), ['Alpha', 'Secret'])
})

test('settings: panel overrides win field by field', () => {
  const merged = effective(config, { persona: { chat: '自定义' }, chats: { [GROUP]: { prompt: '本群聊蔚蓝' } }, updatedAt: 1 })
  assert.equal(merged.persona.chat, '自定义')
  assert.equal(merged.persona.task, '')
  assert.equal(merged.projects.length, 2)
  assert.equal(merged.chats[GROUP]?.prompt, '本群聊蔚蓝')
})

test('privacy: tool guard', () => {
  assert.ok(sensitiveReason({ command: 'cat ~/.dsh/storages/orange/memory.json' }))
  assert.ok(sensitiveReason({ command: 'cat /proc/1/environ' }))
  assert.ok(sensitiveReason({ command: 'env' }))
  assert.ok(sensitiveReason({ path: '/srv/app/.env' }))
  assert.ok(sensitiveReason({ command: 'echo $DEEPSEEK_API_KEY' }))
  assert.equal(sensitiveReason({ content: 'const url = process.env.API_URL' }), undefined)
  assert.equal(sensitiveReason({ path: 'repo/.env.example' }), undefined)
  assert.equal(sensitiveReason({ path: 'work/.dsh/im/chat/file.zip' }), undefined)
  assert.equal(sensitiveReason({ command: 'git status' }), undefined)
  assert.ok(sensitiveReason({ command: 'cat /data/private' }, [/\/data\/private/i]))
})

test('privacy: leak guard', () => {
  const projects = effective(config, undefined).projects
  const content = { type: 'message', attrs: {}, children: [{ type: 'markdown', attrs: { content: 'sekrit 那个仓库修了' }, children: [] }] }
  const text = fragmentText(content)
  assert.match(text, /sekrit/)
  assert.ok(leakReason(text, OTHER, projects, config.admins))
  assert.equal(leakReason(text, GROUP, projects, config.admins), undefined)
  assert.equal(leakReason(text, ADMIN_DM, projects, config.admins), undefined)
  assert.ok(leakReason('看 https://github.com/someone/secret-tool/pull/1', OTHER, projects, config.admins))
  // public projects and ASCII names inside other words pass
  assert.equal(leakReason('alpha 发版了', OTHER, projects, config.admins), undefined)
  assert.equal(leakReason('sekritary', OTHER, projects, config.admins), undefined)
})

test('privacy: hard insults', () => {
  assert.ok(hardInsult('你是 傻逼 吧'))
  assert.ok(!hardInsult('这个 bug 好傻'))
})

test('persona: router, worker and voice sections', () => {
  const settings = effective(config, undefined)
  const base = { settings, projects: projectsFor(settings, GROUP), facts: [], people: [], adminNames: ['老大'], tiers: ['quality'] }
  const router = personaSection({ ...base, role: 'router', chat: GROUP, chatName: '测试群', profile: { prompt: '本群聊蔚蓝', workspace: '/w/celeste' } })
  assert.ok(router.startsWith(CHAT_PERSONA.slice(0, 10)))
  assert.match(router, /主人是测试主人（GitHub someone）/)
  assert.match(router, /M-admin/)
  assert.match(router, /老大/)
  assert.match(router, /Secret/)
  assert.match(router, /本群聊蔚蓝/)
  assert.doesNotMatch(router, /\/w\/celeste/)
  const worker = personaSection({ ...base, role: 'worker', chat: GROUP, profile: { workspace: '/w/celeste' }, agents: '# 规矩\n先跑测试' })
  assert.ok(worker.startsWith(TASK_PERSONA.slice(0, 10)))
  assert.match(worker, /\/w\/celeste/)
  assert.match(worker, /先跑测试/)
  assert.match(worker, /quality/)
  const voice = personaSection({ ...base, role: 'voice', chat: ADMIN_DM })
  assert.match(voice, /小爱音箱/)
  const elsewhere = personaSection({ ...base, role: 'router', chat: OTHER, projects: projectsFor(settings, OTHER) })
  assert.doesNotMatch(elsewhere, /Secret/)
})

test('usage: step usage from session events', () => {
  const none = () => undefined
  assert.equal(usageOf({ type: 'user/message' }, none), undefined)
  assert.deepEqual(
    usageOf({ type: 'assistant/message', data: { usage: { inputTokens: 10, cacheWriteTokens: 2, cacheReadTokens: 5, outputTokens: 3 }, message: { source: { model: 'x' } } } }, none),
    { model: 'x', input: 12, cached: 5, output: 3 },
  )
  assert.deepEqual(usageOf({ type: 'assistant/attempt', data: { stream: [] } }, () => ({ inputTokens: 1 })), { model: 'unknown', input: 1, cached: 0, output: 0 })
  assert.equal(usageOf({ type: 'assistant/message', surfaceOp: 'replace', data: { usage: {} } }, none), undefined)
})

test('github: fresh feedback reaches the linked task once', async () => {
  const store = new OrangeStore(memoryTables(), () => Date.parse('2026-11-20T00:00:00Z'))
  await store.link({ repo: 'a/b', number: '7', kind: 'pr', task: 3, session: 'worker-1' })
  const calls: string[] = []
  const fake = async <T>(args: string[]): Promise<T> => {
    calls.push(args.join(' '))
    const path = args[1] ?? ''
    if (path.startsWith('notifications')) return [{ repository: { full_name: 'a/b' }, subject: { url: 'https://api.github.com/repos/a/b/pulls/7', type: 'PullRequest' } }, { repository: { full_name: 'x/y' }, subject: { url: '.../issues/1' } }] as T
    if (path.includes('/issues/7/comments')) return [{ created_at: '2026-11-20T05:00:00Z', user: { login: 'reviewer' }, body: '改一下命名' }, { created_at: '2026-11-20T06:00:00Z', user: { login: 'bot' }, body: 'done' }] as T
    if (path.endsWith('/reviews')) return [{ submitted_at: '2026-11-20T07:00:00Z', user: { login: 'reviewer' }, body: 'LGTM after that', state: 'COMMENTED' }] as T
    return [] as T
  }
  const delivered: { task: number; text: string; id: string }[] = []
  const deps = { store, gh: fake, log: { info() {}, warn() {} }, now: () => Date.parse('2026-11-20T08:00:00Z'), deliver: async (task: number, _s: string, text: string, id: string) => { delivered.push({ task, text, id }); return true } }
  assert.equal(await pollOnce(deps, 'bot'), 1)
  assert.equal(delivered[0]?.task, 3)
  assert.match(delivered[0]!.text, /改一下命名/)
  assert.match(delivered[0]!.text, /LGTM/)
  assert.doesNotMatch(delivered[0]!.text, /done/)
  assert.equal(store.linkOf('a/b', '7')?.seen, '2026-11-20T08:00:00.000Z')
  assert.equal(store.state('gh:since'), '2026-11-20T08:00:00.000Z')
  assert.ok(calls.some((c) => c.includes('PUT notifications')))
  assert.equal(freshFeedback({ comments: [], reviews: [], reviewComments: [], since: '' }).length, 0)
  assert.match(feedbackText('a/b', '1', [{ at: 't', who: 'w', body: 'b', where: 'comment' }]), /a\/b#1/)
})

test('import-v1: memory, users, stickers and settings, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orange-v1-'))
  await mkdir(join(dir, 'stickers'))
  await writeFile(join(dir, 'stickers', 'a.png'), Buffer.from([1, 2, 3]))
  await writeFile(join(dir, 'export.json'), JSON.stringify({
    version: 1,
    memory: [{ scope: 'global', text: '事实一' }, { scope: `chat:${GROUP}`, text: '群事实' }],
    users: [{ id: 'U1', name: '小明', tags: ['dev'], note: '写 mod' }],
    stickers: [{ file: 'a.png', desc: '猫', tags: ['general'], weight: 70, enabled: true }],
    settings: { projects: [{ name: 'Alpha', aliases: [], repo: 'someone/alpha', note: '' }] },
  }))
  const store = new OrangeStore(memoryTables())
  const uploads: unknown[] = []
  const updates: unknown[] = []
  const sink = {
    upload: async (files: readonly { name?: string; data: Uint8Array }[]) => { uploads.push(files); return [{ id: 9, created: true }] },
    update: async (id: number, patch: object) => { updates.push({ id, ...patch }); return undefined },
  }
  // without the sticker library the import is kept for the next start
  const first = await importV1(dir, store, undefined)
  assert.equal(first.memory, 2)
  assert.equal(store.state('importV1'), undefined)
  const second = await importV1(dir, store, sink)
  assert.equal(second.stickers, 1)
  assert.equal(store.memories({ all: true }).length, 2)
  assert.deepEqual(store.user('U1')?.tags, ['dev'])
  assert.equal(store.user('U1')?.note, '写 mod')
  assert.deepEqual(updates, [{ id: 9, desc: '猫', tags: ['general'], weight: 70, enabled: true }])
  assert.equal(store.settings()?.projects?.[0]?.name, 'Alpha')
  assert.equal((await importV1(dir, store, sink)).skipped, true)
  assert.equal(uploads.length, 1)
})
