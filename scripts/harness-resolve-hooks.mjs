// The module hooks behind `test-resolve.mjs`: a fallback resolver that maps a
// harness specifier to the module inside the harness checkout. Normal resolution
// runs first, so a plugin's own dependencies (`zod`, `esbuild`, …) still come
// from the workspace's node_modules.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let table
let dirs

/**
 * Index every `@deepseek-ai/*` package of a harness checkout by name.
 * @param data - `root`, the checkout as a file URL.
 */
export function initialize(data) {
  const root = fileURLToPath(data.root)
  table = new Map()
  dirs = new Map()
  const visit = (dir, depth) => {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8'))
        if (typeof json.name === 'string' && json.name.startsWith('@deepseek-ai/')) {
          const entry = json.exports?.['.']?.default ?? json.main ?? 'lib/index.js'
          table.set(json.name, join(dir, entry))
          dirs.set(json.name, dir)
        }
      } catch { /* not a package */ }
    }
    if (depth === 0) return
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory() && child.name !== 'node_modules' && !child.name.startsWith('.')) {
        visit(join(dir, child.name), depth - 1)
      }
    }
  }
  visit(join(root, 'vendor'), 1)
  visit(join(root, 'packages'), 2)
}

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    const path = table.get(specifier)
    if (path !== undefined) return { url: pathToFileURL(path).href, shortCircuit: true }
    // `<package>/src/<file>`: a package's `exports` map publishes its sources under this subpath, so a plugin reaches
    // the module the same way it would from an installed copy.
    const at = specifier.indexOf('/src/')
    if (at > 0) {
      const dir = dirs.get(specifier.slice(0, at))
      if (dir !== undefined) return { url: pathToFileURL(join(dir, specifier.slice(at + 1))).href, shortCircuit: true }
    }
    throw error
  }
}
