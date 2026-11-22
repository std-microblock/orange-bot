// Where the harness checkout and the dsh-im-extras checkout are on this machine.
//
// The plugins import the harness's own packages (`@deepseek-ai/dsh-im`,
// `@deepseek-ai/dsh-tools`, …) and the extras' public types
// (`dsh-im-session-tasks`) as peers. Neither is on a registry: inside the
// deployment the profile resolves them from the harness's node_modules and from
// the installed extras packages; here they are resolved by path from built
// checkouts.
//
// Harness: `DSH_HARNESS_ROOT`, then the path in an untracked `.harness-root`
// file at the repository root, then a sibling `../deepseek-harness` or `../dsh`.
// Extras:  `DSH_IM_EXTRAS_ROOT`, then `.extras-root`, then a sibling
// `../dsh-im-extras`.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The path written in an untracked file at the repository root, if it exists. */
function localFile(name) {
  const file = join(repoRoot, name)
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
}

function pick(list) {
  return list.filter((candidate) => candidate !== undefined && candidate !== '').map((candidate) => resolve(candidate))
}

/** Whether a path holds a harness checkout that has been built (declarations emitted). */
export function isBuiltHarness(root) {
  return existsSync(join(root, 'vendor', 'cordis', 'lib', 'types', 'index.d.ts'))
}

/** The harness checkout to resolve the harness peers from. */
export function harnessRoot() {
  const tried = pick([
    process.env.DSH_HARNESS_ROOT,
    localFile('.harness-root'),
    join(repoRoot, '..', 'deepseek-harness'),
    join(repoRoot, '..', 'dsh'),
  ])
  for (const candidate of tried) if (isBuiltHarness(candidate)) return candidate
  throw new Error(
    `no built harness checkout found; set DSH_HARNESS_ROOT or write its path into .harness-root (tried ${tried.join(', ')}). `
      + 'Build it first: `pnpm build` in the checkout.',
  )
}

/** The dsh-im-extras checkout whose public types the plugins are checked against. */
export function extrasRoot() {
  const tried = pick([
    process.env.DSH_IM_EXTRAS_ROOT,
    localFile('.extras-root'),
    join(repoRoot, '..', 'dsh-im-extras'),
  ])
  for (const candidate of tried) if (existsSync(join(candidate, 'packages', 'im-session-tasks', 'package.json'))) return candidate
  throw new Error(`no dsh-im-extras checkout found; set DSH_IM_EXTRAS_ROOT or write its path into .extras-root (tried ${tried.join(', ')})`)
}
