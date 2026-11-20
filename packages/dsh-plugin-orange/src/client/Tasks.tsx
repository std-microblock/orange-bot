/** Background tasks: status, repo/issue/PR links, follow-up instructions. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExternalLink, GitPullRequest, SendHorizontal, Wrench } from 'lucide-react'
import { api, fmtTime } from './api.ts'
import { Badge, ConvLink, Empty, Header, SessionLink, usePanel, type Tone } from './ui.tsx'
import css from './pages.module.css'

const TONE: Record<string, Tone> = { running: 'info', waiting: 'warn', done: 'ok', failed: 'err' }
const STATUS: Record<string, string> = { running: '进行中', waiting: '等待', done: '完成', failed: '失败' }

function Follow({ id }: { id: number }) {
  const { toast } = usePanel()
  const [text, setText] = useState('')
  const send = async () => { if (!text.trim()) return; await api('/task/message', { id, text }); setText(''); toast('已发给任务') }
  return (
    <div className={css.inline}>
      <input className={css.input} value={text} placeholder="追加指示，会恢复原任务 session 继续做" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send() }} />
      <Button size="sm" variant="outline" icon={<SendHorizontal size={14} />} disabled={!text.trim()} onClick={send}>发送</Button>
    </div>
  )
}

export function Tasks() {
  const { tick } = usePanel()
  const [rows, setRows] = useState<any[]>([])
  const [wss, setWss] = useState<any[]>([])
  const [ws, setWs] = useState('')
  useEffect(() => { void api('/workspaces').then((r) => setWss(r.items)).catch(() => {}) }, [])
  useEffect(() => { void api(`/tasks${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`).then(setRows).catch(() => {}) }, [tick, ws])
  return (
    <>
      <Header title="后台任务" sub="调研 / 修 bug / 开 PR，每个任务一个独立 agent session" />
      <div className={css.page}>
        <div className={`${css.feed} ${css.narrow}`}>
          <select className={css.textarea} style={{ width: 220, marginBottom: 8 }} value={ws} onChange={(e) => setWs(e.target.value)}>
            <option value="">全部工作区</option>
            {wss.map((w) => <option key={w.path} value={w.path}>{w.path}{w.default ? '（默认）' : ''}</option>)}
          </select>
          {rows.map((t) => (
            <div key={t.id} className={css.card}>
              <div className={css.top}>
                <span className={css.strong}>#{t.id}</span>
                <Badge tone={TONE[t.status] ?? 'muted'}>{STATUS[t.status] ?? t.status}</Badge>
                <Badge>{t.kind}</Badge>
                <span>{fmtTime(t.created, true)}</span>
                <span>来自 <ConvLink conv={t.conv} /></span>
                <span className={css.grow} />
                <SessionLink id={t.session_id} label="任务 session" />
              </div>
              <div className={css.body} style={{ fontWeight: 500, fontSize: 14 }}>{t.title}</div>
              {(t.repo || t.issue || t.pr) && (
                <div className={css.top} style={{ marginTop: 6 }}>
                  {t.repo && <a href={`https://github.com/${t.repo}`} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {t.repo}</a>}
                  {t.issue && <a href={t.issue} target="_blank" rel="noreferrer">issue ↗</a>}
                  {t.pr && <a href={t.pr} target="_blank" rel="noreferrer"><GitPullRequest size={12} /> PR</a>}
                </div>
              )}
              {t.note && <div className={css.body} style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t.note}</div>}
              <Follow id={t.id} />
            </div>
          ))}
          {!rows.length && <Empty icon={<Wrench size={28} strokeWidth={1.25} />} text="还没有后台任务" />}
        </div>
      </div>
    </>
  )
}
