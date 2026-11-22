/**
 * Browser half of `dsh-plugin-orange`: three dsh-im-panel tabs — 记忆与用户 (long-term memory and people), 橘波特
 * (persona, owner, projects, per-chat profiles) and 用量 (token usage per day, session kind and model).
 */
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClientContext, PanelClient, TabProps } from './panel.ts'

interface MemoryRow { id: number; scope: string; text: string; at: number; from?: string }
interface UserRow { id: string; name?: string; tags: string[]; note?: string; chat?: string; updatedAt: number }
interface UsageRow { day: string; kind: string; model: string; calls: number; input: number; cached: number; output: number }
interface Persona { chat: string; task: string; voice: string }
interface Effective {
  admins: string[]
  owner: { name: string; github?: string; note?: string }
  persona: Persona
  projects: unknown[]
  assistTopics: unknown[]
  chats: Record<string, unknown>
}
interface SettingsView { effective: Effective; saved: Record<string, unknown> | null; builtin: Persona; tiers: Record<string, string> }

const styles = {
  head: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } as const,
  area: { width: '100%', minHeight: 120, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, padding: 8, borderRadius: 8, boxSizing: 'border-box' } as const,
  label: { fontSize: 12, opacity: 0.7, margin: '12px 0 4px' } as const,
  select: { height: 28, borderRadius: 8, padding: '0 8px' } as const,
  num: { textAlign: 'right' } as const,
}

function time(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function errorText(error: unknown): string { return String((error as Error)?.message ?? error) }

// ------------------------------------------------------------------------------------------------- memory tab
function MemoryTab({ read, command, toast, chats }: TabProps) {
  const [query, setQuery] = useState('')
  const [data, setData] = useState<{ memory: MemoryRow[]; users: UserRow[] }>({ memory: [], users: [] })
  const [text, setText] = useState('')
  const [scope, setScope] = useState('global')
  const names = useMemo(() => new Map(chats.map((c) => [c.chat, c.name ?? c.chat])), [chats])

  const load = useCallback(async () => {
    try { setData(await read('', { q: query || undefined })) } catch (error) { toast(errorText(error)) }
  }, [read, query, toast])
  useEffect(() => { void load() }, [load])

  const run = async (body: unknown) => {
    try { toast((await command(body)).text) } catch (error) { toast(errorText(error)) }
    void load()
  }
  const scopeLabel = (s: string) => (s.startsWith('chat:') ? `群 ${names.get(s.slice(5)) ?? s.slice(5)}` : s)

  return (
    <div>
      <div className="im-toolbar" style={styles.head}>
        <Input placeholder="搜索记忆或用户" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button size="sm" onClick={() => { void load() }}>刷新</Button>
      </div>
      <div className="im-card" style={{ marginBottom: 12 }}>
        <div style={styles.head}>
          <select style={styles.select} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">global</option>
            {chats.map((c) => <option key={c.chat} value={`chat:${c.chat}`}>群 {c.name ?? c.chat}</option>)}
          </select>
          <Input placeholder="新的长期记忆（也可以写 user:<id> / project:<名字> 作用域）" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 360 }} />
          <Button size="sm" onClick={() => { if (text.trim()) { void run({ action: 'add-memory', scope, text }); setText('') } }}>记下</Button>
        </div>
      </div>

      <h4>长期记忆（{data.memory.length}）</h4>
      {data.memory.length === 0 && <div className="im-empty">没有记忆</div>}
      <table className="im-table">
        <tbody>
          {data.memory.map((row) => (
            <tr key={row.id}>
              <td className="im-muted">#{row.id}</td>
              <td><span className="im-chip">{scopeLabel(row.scope)}</span></td>
              <td>{row.text}</td>
              <td className="im-muted">{time(row.at)}</td>
              <td>
                <Button size="sm" variant="ghost" onClick={() => {
                  const next = prompt('修改这条记忆', row.text)
                  if (next !== null && next.trim()) void run({ action: 'update-memory', id: row.id, text: next })
                }}>改</Button>
                <Button size="sm" variant="ghost" onClick={() => { if (confirm(`删除 #${row.id}？`)) void run({ action: 'delete-memory', id: row.id }) }}>删</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>认识的人（{data.users.length}）</h4>
      <table className="im-table">
        <tbody>
          {data.users.map((user) => (
            <tr key={user.id}>
              <td>{user.name ?? '—'}</td>
              <td className="im-muted"><code>{user.id}</code></td>
              <td>{user.tags.map((tag) => <Tag key={tag} tone="success">{tag}</Tag>)}</td>
              <td>{user.note ?? ''}</td>
              <td className="im-muted">{user.chat ? names.get(user.chat) ?? user.chat : ''}</td>
              <td>
                <Button size="sm" variant="ghost" onClick={() => { void run({ action: 'user-tag', user: user.id, tag: 'dev', on: !user.tags.includes('dev') }) }}>
                  {user.tags.includes('dev') ? '去掉 dev' : '标 dev'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  const note = prompt('备注', user.note ?? '')
                  if (note !== null) void run({ action: 'user-note', user: user.id, note })
                }}>备注</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ----------------------------------------------------------------------------------------------- settings tab
function JsonField({ label, value, onSave }: { label: string; value: unknown; onSave: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  useEffect(() => { setText(JSON.stringify(value, null, 2)) }, [value])
  return (
    <div>
      <div style={styles.label}>{label}</div>
      <textarea style={styles.area} value={text} onChange={(e) => setText(e.target.value)} />
      <Button size="sm" onClick={() => {
        try { onSave(JSON.parse(text)) } catch (error) { alert(`JSON 不对：${errorText(error)}`) }
      }}>保存</Button>
    </div>
  )
}

function SettingsTab({ read, command, toast, chats }: TabProps) {
  const [view, setView] = useState<SettingsView | undefined>()
  const [persona, setPersona] = useState<Persona>({ chat: '', task: '', voice: '' })
  const [owner, setOwner] = useState({ name: '', github: '', note: '' })

  const load = useCallback(async () => {
    try {
      const next = await read<SettingsView>('')
      setView(next)
      setPersona(next.effective.persona)
      setOwner({ name: next.effective.owner.name, github: next.effective.owner.github ?? '', note: next.effective.owner.note ?? '' })
    } catch (error) { toast(errorText(error)) }
  }, [read, toast])
  useEffect(() => { void load() }, [load])

  const save = async (patch: Record<string, unknown>) => {
    try { toast((await command({ action: 'save', patch })).text) } catch (error) { toast(errorText(error)) }
    void load()
  }
  if (view === undefined) return <div className="im-empty">加载中…</div>

  const personaField = (key: keyof Persona, label: string) => (
    <div>
      <div style={styles.label}>{label}{persona[key].trim() === '' && <span className="im-muted">（空 = 内置）</span>}</div>
      <textarea style={{ ...styles.area, minHeight: 200 }} value={persona[key] || ''} placeholder={view.builtin[key]} onChange={(e) => setPersona({ ...persona, [key]: e.target.value })} />
      <div style={styles.head}>
        <Button size="sm" variant="ghost" onClick={() => setPersona({ ...persona, [key]: view.builtin[key] })}>填入内置文本</Button>
        <Button size="sm" variant="ghost" onClick={() => setPersona({ ...persona, [key]: '' })}>清空（用内置）</Button>
      </div>
    </div>
  )

  return (
    <div>
      <div className="im-card" style={{ marginBottom: 12 }}>
        <strong>主人</strong>
        <div style={styles.head}>
          <Input placeholder="称呼" value={owner.name} onChange={(e) => setOwner({ ...owner, name: e.target.value })} />
          <Input placeholder="GitHub" value={owner.github} onChange={(e) => setOwner({ ...owner, github: e.target.value })} />
          <Input placeholder="补充说明" value={owner.note} onChange={(e) => setOwner({ ...owner, note: e.target.value })} style={{ minWidth: 280 }} />
          <Button size="sm" onClick={() => { void save({ owner: { name: owner.name, ...owner.github ? { github: owner.github } : {}, ...owner.note ? { note: owner.note } : {} } }) }}>保存</Button>
        </div>
        <div className="im-muted" style={{ fontSize: 12 }}>
          管理员（配置文件里改）：{view.effective.admins.length ? view.effective.admins.join('、') : '未配置'}；
          模型档位：{Object.entries(view.tiers).map(([tier, route]) => `${tier}=${route || '未配置'}`).join('，') || '未配置'}
        </div>
      </div>

      <div className="im-card" style={{ marginBottom: 12 }}>
        <strong>人设</strong>
        {personaField('chat', '路由（群聊里的橘波特）')}
        {personaField('task', '后台任务 worker')}
        {personaField('voice', '音箱语音会话（附加）')}
        <Button size="sm" onClick={() => { void save({ persona }) }}>保存人设</Button>
      </div>

      <div className="im-card" style={{ marginBottom: 12 }}>
        <JsonField label="主人的项目（name / aliases / repo / note / org / subs / private / chats）" value={view.effective.projects} onSave={(value) => { void save({ projects: value }) }} />
        <JsonField label="可以帮忙的话题（name / aliases / note）" value={view.effective.assistTopics} onSave={(value) => { void save({ assistTopics: value }) }} />
      </div>

      <div className="im-card">
        <JsonField label="按会话的设置（chat key → name / prompt / workspace / projects）" value={view.effective.chats} onSave={(value) => { void save({ chats: value }) }} />
        <div className="im-muted" style={{ fontSize: 12, marginTop: 6 }}>
          已知会话：{chats.map((c) => `${c.name ?? ''} ${c.chat}`).join('；') || '（还没有）'}。唤醒/回复模式在「会话」页改。
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------- usage tab
function UsageTab({ read, toast }: TabProps) {
  const [days, setDays] = useState(14)
  const [rows, setRows] = useState<UsageRow[]>([])
  useEffect(() => { void read<{ rows: UsageRow[] }>('', { days }).then((r) => setRows(r.rows), (error) => toast(errorText(error))) }, [read, days, toast])
  const totals = useMemo(() => {
    const byKind = new Map<string, UsageRow>()
    for (const row of rows) {
      const key = `${row.kind}|${row.model}`
      const sum = byKind.get(key) ?? { ...row, day: '', calls: 0, input: 0, cached: 0, output: 0 }
      byKind.set(key, { ...sum, calls: sum.calls + row.calls, input: sum.input + row.input, cached: sum.cached + row.cached, output: sum.output + row.output })
    }
    return [...byKind.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
  }, [rows])
  const n = (v: number) => v.toLocaleString()
  const table = (list: UsageRow[], withDay: boolean) => (
    <table className="im-table">
      <thead><tr>{withDay && <th>日期</th>}<th>类别</th><th>模型</th><th>请求</th><th>输入</th><th>缓存命中</th><th>输出</th></tr></thead>
      <tbody>
        {list.map((row) => (
          <tr key={`${row.day}|${row.kind}|${row.model}`}>
            {withDay && <td>{row.day}</td>}
            <td>{row.kind}</td><td className="im-muted">{row.model}</td>
            <td style={styles.num}>{n(row.calls)}</td><td style={styles.num}>{n(row.input)}</td>
            <td style={styles.num}>{n(row.cached)}</td><td style={styles.num}>{n(row.output)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  return (
    <div>
      <div className="im-toolbar" style={styles.head}>
        <select style={styles.select} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 14, 30, 90].map((d) => <option key={d} value={d}>最近 {d} 天</option>)}
        </select>
      </div>
      <h4>合计</h4>
      {totals.length === 0 ? <div className="im-empty">没有用量记录</div> : table(totals, false)}
      <h4>按天</h4>
      {table(rows, true)}
    </div>
  )
}

export const name = 'dsh-plugin-orange'

export function apply(ctx: ClientContext): void {
  ctx.inject(['imPanel'], (scoped) => {
    const panel = scoped.get('imPanel') as PanelClient
    scoped.effect(() => panel.tab({ id: 'orange-memory', title: '记忆与用户', order: 70, component: MemoryTab }), 'orange memory tab')
    scoped.effect(() => panel.tab({ id: 'orange-settings', title: '橘波特', order: 80, component: SettingsTab }), 'orange settings tab')
    scoped.effect(() => panel.tab({ id: 'orange-usage', title: '用量', order: 90, component: UsageTab }), 'orange usage tab')
  })
}
