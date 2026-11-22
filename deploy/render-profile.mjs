#!/usr/bin/env node
// Render the profile template into a DSH profile directory.
//
//   node deploy/render-profile.mjs --out ~/.dsh/profiles/orange [--extras ../dsh-im-extras] [--orange .]
//
// Copies cordis.patch.yml and pnpm-workspace.yaml as they are, and package.json with the @@EXTRAS@@ / @@ORANGE@@
// plugin paths replaced by absolute paths (`file:` dependencies, so `pnpm install` in the profile copies the
// built packages — build both repositories first). Everything else the profile needs comes from the environment
// (deploy/orange.env.example).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const out = option('out')
if (!out) {
  console.error('usage: node deploy/render-profile.mjs --out <profile dir> [--extras <dsh-im-extras>] [--orange <orange-bot>]')
  process.exit(2)
}
const orange = resolve(option('orange', join(here, '..')))
const extras = resolve(option('extras', join(orange, '..', 'dsh-im-extras')))
const posix = (path) => path.replaceAll('\\', '/')

const built = [
  join(extras, 'packages', 'im-dispatch', 'dist', 'index.js'),
  join(extras, 'packages', 'im-session-tasks', 'dist', 'index.js'),
  join(extras, 'packages', 'im-polish', 'dist', 'index.js'),
  join(extras, 'packages', 'im-stickers', 'dist', 'index.js'),
  join(extras, 'packages', 'im-panel', 'dist', 'index.js'),
  join(orange, 'packages', 'dsh-plugin-orange', 'dist', 'index.js'),
  join(orange, 'packages', 'dsh-plugin-orange-voice', 'dist', 'index.js'),
]
const missing = built.filter((file) => !existsSync(file))
if (missing.length) {
  console.error(`not built yet (run \`pnpm build\` in dsh-im-extras and in orange-bot):\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

mkdirSync(out, { recursive: true })
copyFileSync(join(here, 'cordis.patch.yml'), join(out, 'cordis.patch.yml'))
copyFileSync(join(here, 'pnpm-workspace.yaml'), join(out, 'pnpm-workspace.yaml'))
const manifest = readFileSync(join(here, 'package.json'), 'utf8')
  .replaceAll('@@EXTRAS@@', posix(extras))
  .replaceAll('@@ORANGE@@', posix(orange))
writeFileSync(join(out, 'package.json'), manifest)
console.log(`profile rendered into ${resolve(out)} (extras ${extras}, orange ${orange}); now: cd ${out} && pnpm install`)
