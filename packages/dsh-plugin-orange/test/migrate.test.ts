import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { importV1 } from '../src/import-v1.ts'
import { memoryTables, OrangeStore } from '../src/store.ts'

const SCRIPT = resolve(import.meta.dirname, '../../../scripts/migrate-from-v1.mjs')

test('migrate-from-v1: dry run by default, export + import with --write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orange-migrate-'))
  await mkdir(join(dir, 'stickers'))
  await writeFile(join(dir, 'stickers', 'abc.png'), 'png')
  const db = new DatabaseSync(join(dir, 'orange.db'))
  db.exec(`CREATE TABLE conversations (key TEXT PRIMARY KEY, direct INTEGER);
    CREATE TABLE users (key TEXT PRIMARY KEY, name TEXT, tags TEXT, note TEXT, updated INTEGER);
    CREATE TABLE memory (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, scope TEXT, text TEXT);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT, title TEXT, desc_text TEXT, tags TEXT, weight INTEGER, enabled INTEGER);
    INSERT INTO conversations VALUES ('qq:G1', 0), ('qq:U1', 1);
    INSERT INTO users VALUES ('qq:M1', '小明', '["dev"]', '', 1), ('cg:9', 'x', '["dev"]', '', 1);
    INSERT INTO memory (ts, scope, text) VALUES (1, 'global', 'g'), (2, 'group:qq:G1', '群'), (3, 'group:qq:U1', '私聊'), (4, 'group:cg:5', 'cg'), (5, 'user:qq:M1', '人');
    INSERT INTO kv VALUES ('settings', '{"groups":{"qq:G1":{"note":"蔚蓝群","workspace":"/w/c"}},"prompts":{"chat":"","task":"自定义"}}');
    INSERT INTO stickers (file, desc_text, tags, weight, enabled) VALUES ('abc.png', '猫', '["general"]', 70, 1), ('gone.png', '', '[]', 50, 1);`)
  db.close()
  const out = join(dir, 'out')
  const dry = execFileSync(process.execPath, [SCRIPT, '--db', join(dir, 'orange.db'), '--qq-bot', 'qq:1000', '--out', out], { encoding: 'utf8' })
  assert.match(dry, /dry run/)
  assert.equal(existsSync(out), false)
  execFileSync(process.execPath, [SCRIPT, '--db', join(dir, 'orange.db'), '--qq-bot', 'qq:1000', '--out', out, '--write'], { encoding: 'utf8' })
  assert.ok(existsSync(join(out, 'stickers', 'abc.png')))

  const store = new OrangeStore(memoryTables())
  const report = await importV1(out, store, { upload: async () => [{ id: 1, created: true }], update: async () => undefined })
  assert.deepEqual([report.memory, report.users, report.stickers], [4, 1, 1])
  assert.deepEqual(store.memories({ all: true }).map((r) => r.scope).sort(), ['chat:qq:1000|group:G1', 'chat:qq:1000|user:U1', 'global', 'user:M1'])
  assert.deepEqual(store.user('M1')?.tags, ['dev'])
  assert.equal(store.user('9'), undefined)
  assert.deepEqual(store.settings()?.chats, { 'qq:1000|group:G1': { prompt: '蔚蓝群', workspace: '/w/c' } })
  assert.equal(store.settings()?.persona?.task, '自定义')
})
