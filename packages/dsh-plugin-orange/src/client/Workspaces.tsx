/** 工作区管理：全局指示 + 每个工作区的 AGENTS.md 与项目列表覆盖。 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Plus, Save } from 'lucide-react'
import { api } from './api.ts'
import { ItemList, type Item } from './Settings.tsx'
import { Header, usePanel } from './ui.tsx'
import css from './pages.module.css'

type Ws = { path: string, default: boolean, groups: string[], agents: string, projects: Item[] | null }
type Overview = { items: Ws[], globalAgents: string, ownProjects: Item[] }

export function Workspaces() {
  const { toast } = usePanel()
  const [data, setData] = useState<Overview>()
  const [globalAgents, setGlobalAgents] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [agents, setAgents] = useState('')
  const [projects, setProjects] = useState<Item[] | null>(null)
  const load = () => void api('/workspaces').then((d: Overview) => {
    setData(d)
    setGlobalAgents(d.globalAgents)
    if (sel == null || !d.items.some((w) => w.path === sel)) setSel(d.items[0]?.path ?? null)
  }).catch((e) => toast((e as Error).message))
  useEffect(() => { load() }, [])
  useEffect(() => {
    const w = data?.items.find((x) => x.path === sel)
    setAgents(w?.agents ?? '')
    setProjects(w?.projects ?? null)
  }, [sel, data])
  if (!data) return null
  const cur = data.items.find((x) => x.path === sel)
  const saveAgents = async (path: string, content: string) => {
    try { await api('/workspaces/agents', { path, content }); toast('已保存，即时生效') } catch (e) { toast((e as Error).message) }
  }
  const saveProjects = async (path: string, value: Item[] | null) => {
    try { await api('/workspaces/projects', { path, projects: value }); setProjects(value); toast('已保存') } catch (e) { toast((e as Error).message) }
  }
  return (
    <>
      <Header title="工作区" sub="按工作区覆盖 AGENTS.md 和项目列表；群的归属在「会话」右侧面板配置">
        {sel != null && <Button size="sm" variant="primary" icon={<Save size={14} />} onClick={() => saveAgents(sel, agents)}>保存指示</Button>}
      </Header>
      <div className={css.page}><div className={css.narrow}>
        <section className={css.section}>
          <h4>全局指示 · 对所有会话生效</h4>
          <div className={css.hint}>dataDir/AGENTS.md，注入每个 agent session（含后台任务）；保存即生效。全局项目列表在「设置」页编辑</div>
          <textarea className={css.input} rows={8} style={{ fontSize: 12 }} value={globalAgents} placeholder="# 全局规则&#10;（留空 = 不注入任何全局指示）" onChange={(e) => setGlobalAgents(e.target.value)} />
          <div style={{ marginTop: 8 }}><Button size="sm" variant="outline" icon={<Save size={14} />} onClick={() => saveAgents('', globalAgents)}>保存全局指示</Button></div>
        </section>
        <section className={css.section}>
          <h4>工作区</h4>
          <div className={css.hint}>AGENTS.md 是工作区目录里的文件（agent 按工作目录读到）；项目列表覆盖只影响跑在这个工作区里的会话</div>
          <div className={css.feed}>
            {data.items.map((w) => (
              <button key={w.path} className={`${css.card} ${w.path === sel ? '' : ''}`} style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setSel(w.path)}>
                <div className={css.row}>
                  <strong>{w.default ? '默认工作区' : w.path}</strong>
                  {w.groups.length > 0 && <span className={css.muted}>{w.groups.length} 个会话</span>}
                </div>
                <div className={css.muted} style={{ fontSize: 12 }}>{w.path}{w.default ? '（未单独配置工作区的群都在这里）' : ''}{w.projects ? ` · 项目列表已覆盖` : ''}</div>
              </button>
            ))}
          </div>
        </section>
        {cur && (
          <section className={css.section}>
            <h4>{cur.default ? `默认工作区` : '工作区'} · {cur.path}</h4>
            {cur.groups.length > 0 && <div className={css.hint}>使用中的会话：{cur.groups.join('、')}</div>}
            <div className={css.label}>AGENTS.md</div>
            <textarea className={css.input} rows={10} style={{ fontSize: 12 }} value={agents} placeholder="这个工作区的指示（文件不存在会创建）" onChange={(e) => setAgents(e.target.value)} />
            <div style={{ marginTop: 8 }}><Button size="sm" variant="outline" icon={<Save size={14} />} onClick={() => saveAgents(cur.path, agents)}>保存到工作区</Button></div>
            <div className={css.label} style={{ marginTop: 16 }}>项目列表{projects == null && <span className={css.muted}>（跟随全局）</span>}</div>
            {projects == null
              ? <Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => saveProjects(cur.path, structuredClone(data.ownProjects))}>覆盖全局列表</Button>
              : <>
                  <ItemList items={projects} repo onChange={(v) => setProjects(v)} />
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <Button size="sm" variant="primary" icon={<Save size={14} />} onClick={() => saveProjects(cur.path, projects)}>保存项目列表</Button>
                    <Button size="sm" variant="ghost" onClick={() => saveProjects(cur.path, null)}>恢复跟随全局</Button>
                  </div>
                </>}
          </section>
        )}
      </div></div>
    </>
  )
}
