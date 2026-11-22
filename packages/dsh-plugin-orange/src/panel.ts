/**
 * The host half of the bot's dsh-im-panel tabs, described structurally (no dependency on the panel package):
 *
 * - `orange-memory` 记忆与用户 — `GET` `{ memory, users }` (`q`, `scope`, `chat`); `POST` `add-memory`, `update-memory`,
 *   `delete-memory`, `user-tag`, `user-note`.
 * - `orange-settings` 橘波特 — `GET` `{ effective, saved, builtin, tiers }`; `POST` `save` (persona, owner, projects,
 *   assistTopics, chats — each field optional, `null` returns it to the config seed).
 * - `orange-usage` 用量 — `GET` `{ rows }` (`days`).
 *
 * @module dsh-plugin-orange/panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { CHAT_PERSONA, TASK_PERSONA, VOICE_PERSONA } from './persona.ts'
import type { Effective } from './roles.ts'
import { normalizeScope, type OrangeStore, type SettingsRecord } from './store.ts'

export interface PanelTabDefinition {
  id: string
  title: string
  order?: number
  badge?: () => number | undefined
  read?: (request: { path: string; query: URLSearchParams }) => Promise<unknown>
  command?: (request: { path: string; body: unknown }) => Promise<unknown>
}

interface PanelHost { tab(definition: PanelTabDefinition): () => void }

export interface PanelDeps {
  store: OrangeStore
  config: Config
  settings: () => Effective
}

export function memoryTab({ store }: PanelDeps): PanelTabDefinition {
  return {
    id: 'orange-memory',
    title: '记忆与用户',
    order: 70,
    read: async ({ query }) => ({
      memory: store.memories({
        all: true,
        ...query.get('q') ? { query: query.get('q')! } : {},
        ...query.get('scope') ? { scope: query.get('scope')! } : {},
        limit: Number(query.get('limit') ?? 200) || 200,
      }),
      users: store.users(query.get('q') ?? undefined).slice(0, 500),
    }),
    command: async ({ body }) => {
      const c = (body ?? {}) as { action?: string; id?: number; scope?: string; text?: string; user?: string; tag?: string; on?: boolean; note?: string; chat?: string }
      switch (c.action) {
        case 'add-memory': {
          const row = await store.addMemory(normalizeScope(c.scope, c.chat), String(c.text ?? ''))
          return { ok: true, text: `已记下 #${row.id}` }
        }
        case 'update-memory': {
          const row = await store.updateMemory(Number(c.id), { ...c.text ? { text: c.text } : {}, ...c.scope ? { scope: c.scope } : {} })
          return { ok: row !== undefined, text: row ? `已更新 #${row.id}` : '没有这条记忆' }
        }
        case 'delete-memory':
          return { ok: await store.deleteMemory(Number(c.id)), text: `已删除 #${c.id}` }
        case 'user-tag':
          await store.setUserTag(String(c.user), String(c.tag), c.on !== false)
          return { ok: true, text: '已更新标签' }
        case 'user-note':
          await store.setUserNote(String(c.user), String(c.note ?? ''))
          return { ok: true, text: '已更新备注' }
        default:
          throw new Error(`unknown action ${String(c.action)}`)
      }
    },
  }
}

export function settingsTab({ store, config, settings }: PanelDeps): PanelTabDefinition {
  return {
    id: 'orange-settings',
    title: '橘波特',
    order: 80,
    read: async () => ({
      effective: settings(),
      saved: store.settings() ?? null,
      builtin: { chat: CHAT_PERSONA, task: TASK_PERSONA, voice: VOICE_PERSONA },
      tiers: Object.fromEntries(Object.entries(config.taskModels).map(([tier, route]) => [tier, route ? `${route.provider}/${route.model}` : ''])),
    }),
    command: async ({ body }) => {
      const c = (body ?? {}) as { action?: string; patch?: Record<string, unknown> }
      if (c.action !== 'save') throw new Error(`unknown action ${String(c.action)}`)
      const patch = c.patch ?? {}
      const current: Partial<SettingsRecord> = { ...store.settings() }
      for (const key of ['persona', 'owner', 'projects', 'assistTopics', 'chats'] as const) {
        if (!(key in patch)) continue
        if (patch[key] === null) delete current[key]
        else (current as Record<string, unknown>)[key] = patch[key]
      }
      delete current.updatedAt
      await store.tables.settings.put('current', { ...current, updatedAt: Date.now() })
      return { ok: true, text: '已保存，下一轮对话生效' }
    },
  }
}

export function usageTab({ store }: PanelDeps): PanelTabDefinition {
  return {
    id: 'orange-usage',
    title: '用量',
    order: 90,
    read: async ({ query }) => {
      const days = Math.max(1, Math.min(Number(query.get('days') ?? 14) || 14, 365))
      const since = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10)
      return { rows: store.usage(since), days }
    },
  }
}

/** Register the tabs once dsh-im-panel is mounted. */
export function applyPanel(ctx: Context, deps: PanelDeps): void {
  ctx.inject(['imPanel' as never], (scoped) => {
    const panel = (scoped as unknown as { imPanel: PanelHost }).imPanel
    for (const tab of [memoryTab(deps), settingsTab(deps), usageTab(deps)]) scoped.effect(() => panel.tab(tab), `orange: ${tab.id} tab`)
  })
}
