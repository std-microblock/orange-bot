/** One conversation: header, message timeline with bot events, composer, settings drawer. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ArrowDown, PanelRight, SendHorizontal } from 'lucide-react'
import { api, convName, type Conv, type Msg, type Route } from './api.ts'
import { Avatar, Badge, Empty, SessionLink, usePanel } from './ui.tsx'
import { Message, EventLine, DayLine } from './Message.tsx'
import { ConvSettings } from './ConvSettings.tsx'
import css from './ChatView.module.css'

type Data = { messages: Msg[], responses: any[], classifications: any[], avatars: Record<string, string>, roles: Record<string, string>, groupRoles: { id: string, role: string, name: string }[], session: string | null, hasMore: boolean }
const EMPTY: Data = { messages: [], responses: [], classifications: [], avatars: {}, roles: {}, groupRoles: [], session: null, hasMore: false }

export function ChatView({ conv }: { conv: Conv }) {
  const { tick, route, go, toast } = usePanel()
  const [data, setData] = useState<Data>(EMPTY)
  const [older, setOlder] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  const [side, setSide] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const box = useRef<HTMLDivElement>(null)
  const jumped = useRef<Route | undefined>(undefined)
  const target = route.seq
  useEffect(() => {
    void api(`/messages?conv=${encodeURIComponent(conv.key)}&limit=120${target ? `&around=${target}` : ''}`).then(setData).catch(() => {})
  }, [conv.key, tick, target])
  // Jump to the linked message once per navigation: live events refetch the timeline
  // (new `data` identity) and must not drag the view back to it over and over.
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (!target) {
      jumped.current = undefined
      if (atBottom) el.scrollTop = el.scrollHeight
      return
    }
    if (jumped.current === route) return
    const row = el.querySelector<HTMLElement>(`[data-seq="${target}"]`)
    if (!row) return
    jumped.current = route
    row.scrollIntoView({ block: 'center' })
    row.dataset.flash = '1'
    setTimeout(() => { delete row.dataset.flash }, 1500)
  }, [data, target, route])
  const messages = useMemo(() => {
    const seen = new Set<number>()
    return [...older, ...data.messages].filter((m) => !seen.has(m.seq) && !!seen.add(m.seq))
  }, [older, data.messages])
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  const timeline = useMemo(() => {
    const items: { ts: number, kind: string, v: any }[] = messages.map((m) => ({ ts: m.ts, kind: 'msg', v: m }))
    for (const r of data.responses) {
      const kind = r.dry_run ? 'dry' : r.error ? 'err' : r.trigger === 'no_reply' ? 'noreply' : r.trigger === 'react' ? 'react' : ''
      if (kind) items.push({ ts: r.ts, kind, v: r })
    }
    for (const c of data.classifications) if (c.wake) items.push({ ts: c.ts, kind: 'wake', v: c })
    return items.sort((a, b) => a.ts - b.ts)
  }, [messages, data])
  const loadOlder = async () => {
    const first = messages[0]
    if (!first) return
    const d = await api(`/messages?conv=${encodeURIComponent(conv.key)}&before=${first.seq}&limit=100`)
    setOlder((o) => [...d.messages, ...o])
  }
  const send = async () => {
    if (!draft.trim()) return
    try { await api('/send', { conv: conv.key, text: draft }); setDraft(''); toast(conv.settings.dryRun ? '已记录（dry run）' : '已发送') } catch (e) { toast((e as Error).message) }
  }
  const toBottom = () => {
    if (target) go({ tab: 'chats', conv: conv.key })
    const el = box.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
  let lastDay = ''
  let prev: Msg | undefined
  return (
    <div className={css.wrap}>
      <section className={css.chat}>
        <header className={css.head}>
          <Avatar src={conv.avatar} name={convName(conv, conv.key)} seed={conv.key} size={36} square={!conv.direct} />
          <div className={css.headText}>
            <div className={css.title}>{convName(conv, conv.key)}{conv.settings.dryRun && <Badge tone="warn">DRY RUN</Badge>}</div>
            <div className={css.sub}>{conv.platform === 'qq' ? 'QQ 官方 bot' : conv.platform === 'cg' ? 'userbot' : conv.platform}{conv.direct ? ' · 私聊' : ''} · {conv.count} 条{data.groupRoles.length ? <> · {data.groupRoles.map((r) => <span key={r.id} className={css.role} title={`${r.id} — ${r.name}`}>{r.role === 'owner' ? '群主' : '群管'} {r.name}</span>)}</> : null}</div>
          </div>
          <SessionLink id={data.session} label="agent 会话" />
          <Button size="sm" variant={side ? 'outline' : 'ghost'} icon={<PanelRight size={14} />} onClick={() => setSide(!side)}>设置</Button>
        </header>
        <div className={css.timeline} ref={box} onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }}>
          {data.hasMore && !target && <div className={css.more}><Button size="sm" variant="outline" onClick={loadOlder}>加载更早的消息</Button></div>}
          {timeline.map((it) => {
            const day = new Date(it.ts).toDateString()
            const dayLine = day !== lastDay ? <DayLine ts={it.ts} /> : null
            lastDay = day
            if (it.kind !== 'msg') { prev = undefined; return <div key={`${it.kind}${it.v.id}`}>{dayLine}<EventLine kind={it.kind} v={it.v} /></div> }
            const m: Msg = it.v
            const cont = !dayLine && !!prev && prev.senderId === m.senderId && prev.fromBot === m.fromBot && m.ts - prev.ts < 180_000
            prev = m
            return <div key={m.seq}>{dayLine}<Message m={m} cont={cont} avatar={data.avatars[m.senderId]} role={data.roles[m.senderId]} quoted={m.replyTo ? byId.get(m.replyTo) : undefined} /></div>
          })}
          {!timeline.length && <Empty text="还没有记录" />}
        </div>
        {(!atBottom || target) && <button className={css.jump} onClick={toBottom}><ArrowDown size={16} /></button>}
        <footer className={css.compose}>
          <textarea className={css.input} rows={1} value={draft} placeholder={conv.settings.dryRun ? '以橘波特身份发送（dry run：只记录）' : '以橘波特身份发送，Enter 发送'}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
          <Button variant="primary" size="sm" icon={<SendHorizontal size={14} />} disabled={!draft.trim()} onClick={send}>发送</Button>
        </footer>
      </section>
      {side && <ConvSettings conv={conv} session={data.session} />}
    </div>
  )
}
