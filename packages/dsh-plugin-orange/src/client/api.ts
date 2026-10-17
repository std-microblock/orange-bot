/** Panel data access, formatting, hash routing, and the live event stream. */
import { useCallback, useEffect, useRef, useState } from 'react'

export type Tab = 'chats' | 'responses' | 'tasks' | 'stickers' | 'memory' | 'stats' | 'settings'
export type Group = { whitelisted: boolean, dryRun: boolean, listen: boolean, triggerLimit?: 'all' | 'groupAdmin' | 'botAdmin', tags: string[], note: string, peer?: string }
export type Conv = { key: string, platform: 'qq' | 'cg', channelId: string, title: string, direct: boolean, lastTs: number, count: number, avatar?: string, settings: Group }
export type Msg = { seq: number, conv: string, id: string, senderId: string, senderName: string, ts: number, text: string, raw: string, replyTo?: string, self: boolean, fromBot: boolean, mentionsSelf: boolean }
export type Route = { tab: Tab, conv?: string, seq?: number }

export async function api(path: string, body?: unknown): Promise<any> {
  const init: RequestInit = body === undefined ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(`./orange-api${path}`, init)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json
}

const pad = (n: number) => String(n).padStart(2, '0')
export function fmtTime(ts: number, full = false): string {
  if (!ts) return ''
  const d = new Date(ts), now = new Date()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (full) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  if (d.toDateString() === now.toDateString()) return hm
  if (now.getTime() - ts < 6 * 86400_000) return '周' + '日一二三四五六'[d.getDay()]
  return `${d.getMonth() + 1}/${d.getDate()}`
}
export function ago(ts: number): string {
  if (!ts) return '—'
  const s = (Date.now() - ts) / 1000
  return s < 60 ? '刚刚' : s < 3600 ? `${~~(s / 60)} 分钟前` : s < 86400 ? `${~~(s / 3600)} 小时前` : `${~~(s / 86400)} 天前`
}
export const usd = (n: number) => `$${(n ?? 0).toFixed(n >= 1 ? 2 : 4)}`
export const num = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0)
export const convName = (c: Conv | undefined, key: string) => c?.title || (c?.direct ? `私聊 ${key.slice(3, 9)}…` : `${key.slice(3, 11)}…`)

export function parseHash(): Route {
  const m = /^#orange\/([a-z]+)(?:\/([^/]+))?(?:\/(\d+))?/.exec(location.hash)
  if (!m) return { tab: 'chats' }
  return { tab: m[1] as Tab, conv: m[2] && decodeURIComponent(m[2]), seq: m[3] ? Number(m[3]) : undefined }
}
export const hashOf = (r: Route) => `#orange/${r.tab}${r.conv ? '/' + encodeURIComponent(r.conv) : ''}${r.seq ? '/' + r.seq : ''}`

export function useRoute(): [Route, (r: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(parseHash)
  useEffect(() => {
    const on = () => setRoute(parseHash())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const go = useCallback((r: Partial<Route>) => {
    setRoute((cur) => {
      const next = { ...cur, seq: undefined, ...r }
      if (location.hash !== hashOf(next)) history.pushState(null, '', hashOf(next))
      return next
    })
  }, [])
  return [route, go]
}

export function useEvents(onEvent: (e: any) => void): void {
  const ref = useRef(onEvent)
  ref.current = onEvent
  useEffect(() => {
    const source = new EventSource('./orange-api/events', { withCredentials: true })
    source.onmessage = (e) => { try { ref.current(JSON.parse(e.data)) } catch {} }
    return () => source.close()
  }, [])
}
