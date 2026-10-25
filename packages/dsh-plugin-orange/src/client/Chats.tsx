/** Conversation list (left) + chat view (right). */
import { useEffect, useMemo, useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { MessagesSquare, Search } from 'lucide-react'
import { api, convName, fmtTime, type Conv } from './api.ts'
import { Avatar, Badge, Chips, Empty, usePanel } from './ui.tsx'
import { ChatView } from './ChatView.tsx'
import css from './Chats.module.css'

type Filter = 'all' | 'white' | 'dm' | (string & {})
const BASE_FILTERS = [['all', '全部'], ['white', '白名单'], ['qq', '官方'], ['cg', 'userbot'], ['dm', '私聊']] as const

const blank = (key: string): Conv => ({ key, platform: key.slice(0, 2) as Conv['platform'], channelId: key.slice(3), title: '', direct: false, lastTs: 0, count: 0, settings: { whitelisted: false, dryRun: false, listen: false, tags: [], note: '' } })

export function Chats() {
  const { convs, byKey, route, go, tick } = usePanel()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [previews, setPreviews] = useState<Record<string, string>>({})
  useEffect(() => { void api('/previews').then(setPreviews).catch(() => {}) }, [tick])
  // platforms beyond the built-in pair get their own filter chip, labelled by key
  const filters = useMemo(() => {
    const extra = [...new Set(convs.map((c) => c.platform))].filter((p) => p !== 'qq' && p !== 'cg').map((p) => [p, p] as const)
    return [...BASE_FILTERS, ...extra]
  }, [convs])
  const list = useMemo(() => convs
    .filter((c) => !q || (c.title + c.key).toLowerCase().includes(q.toLowerCase()))
    .filter((c) => filter === 'all' || (filter === 'white' && c.settings.whitelisted) || (filter === 'dm' && c.direct) || (filter === c.platform && !c.direct))
    .sort((a, b) => b.lastTs - a.lastTs), [convs, q, filter])
  const current = route.conv ? byKey.get(route.conv) ?? blank(route.conv) : undefined
  return (
    <div className={css.split}>
      <aside className={css.list}>
        <div className={css.listTop}>
          <Input icon={<Search size={14} />} placeholder="搜索群名或 id" value={q} onChange={(e) => setQ(e.target.value)} className={css.search} />
          <Chips value={filter} options={filters} onChange={setFilter} />
        </div>
        <div className={css.items}>
          {list.map((c) => (
            <button key={c.key} className={`${css.item} ${c.key === route.conv ? css.on : ''}`} onClick={() => go({ tab: 'chats', conv: c.key })}>
              <Avatar src={c.avatar} name={convName(c, c.key)} seed={c.key} size={40} square={!c.direct} />
              <span className={css.itemMain}>
                <span className={css.row}><span className={css.name}>{convName(c, c.key)}</span><span className={css.time}>{fmtTime(c.lastTs)}</span></span>
                <span className={css.row}>
                  <span className={css.preview}>{previews[c.key] ?? (c.direct ? '私聊' : '暂无消息')}</span>
                  {c.settings.dryRun && <Badge tone="warn">dry</Badge>}
                  {c.settings.whitelisted && <Badge tone="ok">白名单</Badge>}
                  <Badge>{c.platform === 'qq' ? '官' : c.platform === 'cg' ? 'U' : c.platform}</Badge>
                </span>
              </span>
            </button>
          ))}
          {!list.length && <Empty text="没有匹配的会话" />}
        </div>
      </aside>
      {current ? <ChatView key={current.key} conv={current} /> : <Empty icon={<MessagesSquare size={32} strokeWidth={1.25} />} text="选择一个会话" />}
    </div>
  )
}
