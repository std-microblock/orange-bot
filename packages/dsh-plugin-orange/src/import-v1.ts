/**
 * One-time import of what `scripts/migrate-from-v1.mjs` exported from the v1 database (`~/.orange/orange.db`):
 * long-term memory, user tags and notes, the sticker library (into dsh-im-stickers, through its public
 * `ctx.imStickers`), and the panel settings v1 kept (projects, assist topics, persona overrides).
 *
 * The export is read once: its content hash is recorded in the `orange` domain's `state` table, so a restart or a
 * second mount does not import it again. Messages, responses, classifier runs and tasks are not migrated.
 *
 * @module dsh-plugin-orange/import-v1
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AssistTopic, OwnProject } from './config.ts'
import type { OrangeStore } from './store.ts'

export interface V1Export {
  version: 1
  memory: { scope: string; text: string; at?: number }[]
  users: { id: string; name?: string; tags?: string[]; note?: string }[]
  stickers: { file: string; title?: string; desc?: string; tags?: string[]; weight?: number; enabled?: boolean }[]
  settings?: {
    persona?: { chat?: string; task?: string }
    projects?: OwnProject[]
    assistTopics?: AssistTopic[]
  }
}

/** The part of `ctx.imStickers` the import uses. */
export interface StickerSink {
  upload(files: readonly { name?: string; data: Uint8Array }[]): Promise<({ id: number; created: boolean } | { error: string; name?: string })[]>
  update(id: number, patch: { desc?: string; tags?: string[]; weight?: number; enabled?: boolean; title?: string }): Promise<unknown>
}

export interface ImportReport { memory: number; users: number; stickers: number; skipped: boolean; errors: string[] }

export async function importV1(dir: string, store: OrangeStore, stickers: StickerSink | undefined): Promise<ImportReport> {
  const raw = await readFile(join(dir, 'export.json'), 'utf8')
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const report: ImportReport = { memory: 0, users: 0, stickers: 0, skipped: false, errors: [] }
  if (store.state('importV1') === hash) return { ...report, skipped: true }
  const data = JSON.parse(raw) as V1Export
  if (data.version !== 1) throw new Error(`unknown export version ${String((data as { version?: unknown }).version)}`)

  for (const fact of data.memory ?? []) {
    try { await store.addMemory(fact.scope, fact.text); report.memory += 1 } catch (error) { report.errors.push(`memory: ${(error as Error).message}`) }
  }
  for (const user of data.users ?? []) {
    for (const tag of user.tags ?? []) {
      try { await store.setUserTag(user.id, tag, true) } catch { /* a tag v2 does not know */ }
    }
    if (user.note) await store.setUserNote(user.id, user.note)
    if (user.name) await store.seen(user.id, user.name, store.user(user.id)?.chat ?? '')
    report.users += 1
  }
  if (data.settings !== undefined && store.settings() === undefined) {
    await store.saveSettings({
      ...data.settings.projects ? { projects: data.settings.projects } : {},
      ...data.settings.assistTopics ? { assistTopics: data.settings.assistTopics } : {},
      ...data.settings.persona ? { persona: data.settings.persona } : {},
    })
  }
  if ((data.stickers ?? []).length > 0) {
    if (stickers === undefined) report.errors.push('dsh-im-stickers is not mounted: stickers skipped (mount it and restart to import them)')
    else {
      for (const sticker of data.stickers) {
        try {
          const bytes = await readFile(join(dir, 'stickers', basename(sticker.file)))
          const [result] = await stickers.upload([{ name: sticker.title || basename(sticker.file), data: new Uint8Array(bytes) }])
          if (result === undefined || 'error' in result) { report.errors.push(`sticker ${sticker.file}: ${result?.error ?? 'no result'}`); continue }
          await stickers.update(result.id, {
            ...sticker.desc ? { desc: sticker.desc } : {},
            ...sticker.tags?.length ? { tags: sticker.tags } : {},
            ...sticker.weight !== undefined ? { weight: sticker.weight } : {},
            ...sticker.enabled !== undefined ? { enabled: sticker.enabled } : {},
          })
          report.stickers += 1
        } catch (error) {
          report.errors.push(`sticker ${sticker.file}: ${(error as Error).message}`)
        }
      }
    }
  }
  // Stickers that could not be imported because the library was missing are retried on the next start.
  if (!report.errors.some((e) => e.startsWith('dsh-im-stickers is not mounted'))) await store.setState('importV1', hash)
  return report
}
