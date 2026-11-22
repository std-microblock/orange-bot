/**
 * The part of `dsh-im-panel`'s browser API the bot's tabs use, written structurally so the package has no
 * dependency on the panel (see the panel's README, "Tab extension API").
 */
import type { ComponentType } from 'react'

export type Query = Record<string, string | number | boolean | undefined>

export interface PanelChat {
  chat: string
  name?: string
  platform: string
}

export interface TabProps {
  id: string
  url(path?: string, query?: Query): string
  fetch(path?: string, init?: RequestInit & { query?: Query }): Promise<Response>
  read<T>(path?: string, query?: Query): Promise<T>
  command<T = { ok: boolean; text: string }>(body: unknown, path?: string): Promise<T>
  upload<T>(path: string, files: readonly File[], fields?: Record<string, string>): Promise<T>
  toast(text: string): void
  openSession(sessionId: string): void
  refresh(): void
  chats: readonly PanelChat[]
}

export interface PanelClient {
  tab(definition: {
    id: string
    title: string
    order?: number
    icon?: ComponentType<{ size?: number; className?: string }>
    component: ComponentType<TabProps>
  }): () => void
}

export interface ClientContext {
  inject(services: string[], callback: (scoped: ClientContext) => void): void
  effect(execute: () => () => void, label?: string): void
  get(name: string): unknown
}
