/** Shared panel atoms on top of dsh primitives. */
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ArrowUpRight } from 'lucide-react'
import { convName, type Conv, type Route } from './api.ts'
import css from './ui.module.css'

export interface Ctx {
  go: (r: Partial<Route>) => void
  route: Route
  byKey: Map<string, Conv>
  convs: Conv[]
  /** Platform display names from the config (panel labels). */
  labels: Record<string, string>
  tick: number
  /** Bumped only by sticker events, so the sticker page can reload on its own. */
  stickerTick: number
  /** Latest import/classify job progress pushed over SSE. */
  stickerJob?: unknown
  reload: () => void
  openSession: (id: string) => void
  toast: (s: string) => void
  zoom: (src: string) => void
}
export const PanelCtx = createContext<Ctx>(null as any)
export const usePanel = () => useContext(PanelCtx)

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)

/** Real QQ avatar when known, else a coloured initial. */
export function Avatar({ src, name, seed, size = 32, square }: { src?: string, name: string, seed: string, size?: number, square?: boolean }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size, borderRadius: square ? size * 0.28 : '50%' }
  if (src && !broken) return <img className={css.avatar} style={style} src={src} referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
  const ch = [...name.replace(/^[\s#\d.丨|·]+/, '')][0] ?? '?'
  return <span className={css.avatarText} style={{ ...style, fontSize: size * 0.42, background: `hsl(${hue(seed)} 50% 52%)` }}>{ch}</span>
}

export function ConvLink({ conv, seq }: { conv: string, seq?: number }) {
  const { go, byKey } = usePanel()
  return <button className={css.link} onClick={(e) => { e.stopPropagation(); go({ tab: 'chats', conv, seq }) }}>{convName(byKey.get(conv), conv)}</button>
}

export function SessionLink({ id, label = '会话上下文' }: { id?: string | null, label?: string }) {
  const { openSession } = usePanel()
  if (!id) return null
  return (
    <Tooltip label="在 dsh 中打开这个 agent session（完整上下文与工具调用）" side="top" portal>
      <button className={css.link} onClick={(e) => { e.stopPropagation(); openSession(id) }}>{label}<ArrowUpRight size={12} /></button>
    </Tooltip>
  )
}

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted'
export function Badge({ tone = 'muted', children }: { tone?: Tone, children: ReactNode }) {
  if (tone === 'muted') return <Tag>{children}</Tag>
  return <span className={`${css.badge} ${css[tone]}`}>{children}</span>
}

export function Header({ title, sub, children }: { title: ReactNode, sub?: ReactNode, children?: ReactNode }) {
  return (
    <div className={css.header}>
      <div className={css.headerText}><div className={css.title}>{title}</div>{sub && <div className={css.sub}>{sub}</div>}</div>
      <div className={css.headerActions}>{children}</div>
    </div>
  )
}

export function Empty({ icon, text }: { icon?: ReactNode, text: string }) {
  return <div className={css.empty}>{icon}<span>{text}</span></div>
}

export function Field({ label, hint, children }: { label: string, hint?: string, children: ReactNode }) {
  return (
    <label className={css.field}>
      <span className={css.fieldText}><span>{label}</span>{hint && <span className={css.hint}>{hint}</span>}</span>
      {children}
    </label>
  )
}

export function Chips<T extends string>({ value, options, onChange }: { value: T, options: readonly (readonly [T, string])[], onChange: (v: T) => void }) {
  return (
    <div className={css.chips}>
      {options.map(([v, l]) => <button key={v} className={`${css.chip} ${v === value ? css.chipOn : ''}`} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  )
}
