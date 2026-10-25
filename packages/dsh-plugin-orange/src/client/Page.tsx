/** Panel shell: left nav, routed page, lightbox and toast. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImageLightbox, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { BarChart3, Brain, MessagesSquare, Send, Settings2, Smile, Wrench } from 'lucide-react'
import { api, useEvents, useRoute, type Conv, type Tab } from './api.ts'
import { PanelCtx, type Ctx } from './ui.tsx'
import { Chats } from './Chats.tsx'
import { Responses } from './Responses.tsx'
import { Tasks } from './Tasks.tsx'
import { Stickers } from './Stickers.tsx'
import { Memory } from './Memory.tsx'
import { Stats } from './Stats.tsx'
import { GlobalSettings } from './Settings.tsx'
import css from './Page.module.css'

const TABS: { id: Tab, label: string, Icon: typeof Send }[] = [
  { id: 'chats', label: '会话', Icon: MessagesSquare },
  { id: 'responses', label: '响应记录', Icon: Send },
  { id: 'stickers', label: '表情', Icon: Smile },
  { id: 'tasks', label: '后台任务', Icon: Wrench },
  { id: 'memory', label: '记忆与用户', Icon: Brain },
  { id: 'stats', label: '用量', Icon: BarChart3 },
  { id: 'settings', label: '设置', Icon: Settings2 },
]

export function OrangePage({ openSession }: { openSession: (id: string) => void }) {
  const [route, go] = useRoute()
  const [overview, setOverview] = useState<any>()
  const [status, setStatus] = useState<Record<string, string>>({})
  const [tick, setTick] = useState(0)
  const [stickerTick, setStickerTick] = useState(0)
  const [stickerJob, setStickerJob] = useState<unknown>()
  const [toast, setToast] = useState('')
  const [zoom, setZoom] = useState<string>()
  const reload = useCallback(() => { void api('/overview').then((o) => { setOverview(o); setStatus(o.status) }).catch(() => {}) }, [])
  useEffect(reload, [reload])
  useEvents((e) => {
    if (e.type === 'status') setStatus(e.status)
    if (e.type === 'settings') reload()
    // Sticker events are frequent during an import (one per sticker), so they get
    // their own counter: only the sticker page listens to it.
    if (e.type === 'sticker' || e.type === 'sticker-job') {
      setStickerTick((t) => t + 1)
      if (e.type === 'sticker-job') setStickerJob(e.job)
      return
    }
    setTick((t) => t + 1)
  })
  const convs: Conv[] = overview?.conversations ?? []
  const byKey = useMemo(() => new Map(convs.map((c) => [c.key, c])), [convs])
  const ctx: Ctx = { go, route, byKey, convs, tick, stickerTick, stickerJob, reload, openSession, toast: setToast, zoom: setZoom }
  const Body = { chats: Chats, responses: Responses, tasks: Tasks, stickers: Stickers, memory: Memory, stats: Stats, settings: GlobalSettings }[route.tab] ?? Chats
  return (
    <PanelCtx.Provider value={ctx}>
      <div className={css.root}>
        <nav className={css.nav}>
          <div className={css.brand}><span className={css.logo}>🍊</span>橘波特</div>
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} className={`${css.navItem} ${route.tab === id ? css.navOn : ''}`} onClick={() => go({ tab: id, conv: id === 'chats' ? route.conv : undefined })}>
              <Icon size={16} strokeWidth={1.75} />{label}
            </button>
          ))}
          <div className={css.status}>
            {Object.keys(status).map((k) => (
              <div key={k} className={css.statusRow}><span className={`${css.dot} ${status[k] === 'ready' ? css.dotOk : css.dotBad}`} />{k === 'qq' ? '官方 bot' : k === 'cg' ? 'userbot' : k}<span className={css.statusText}>{status[k] === 'ready' ? '在线' : status[k] ?? '…'}</span></div>
            ))}
          </div>
        </nav>
        <main className={css.main}>{overview ? <Body /> : null}</main>
        {zoom && <ImageLightbox src={zoom} alt="" labels={{ dialog: '图片预览', close: '关闭' }} onClose={() => setZoom(undefined)} />}
        {toast && <Toast text={toast} onDone={() => setToast('')} />}
      </div>
    </PanelCtx.Provider>
  )
}
