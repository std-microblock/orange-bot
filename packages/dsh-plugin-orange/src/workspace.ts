/**
 * A chat workspace's `AGENTS.md`, read for the worker prompt. Prompt assembly is synchronous, so the file is read
 * with `readFileSync` and cached by modification time; a missing or unreadable file contributes nothing.
 *
 * @module dsh-plugin-orange/workspace
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const cache = new Map<string, { mtime: number; text: string }>()

export function agentsText(workspace: string | undefined, maxChars: number): string | undefined {
  if (!workspace || maxChars <= 0) return undefined
  const file = join(workspace, 'AGENTS.md')
  try {
    const mtime = statSync(file).mtimeMs
    const hit = cache.get(file)
    if (hit !== undefined && hit.mtime === mtime) return hit.text
    const raw = readFileSync(file, 'utf8')
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…（已截断）` : raw
    cache.set(file, { mtime, text })
    return text
  } catch {
    return undefined
  }
}
