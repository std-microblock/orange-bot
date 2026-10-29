/** 工作区管理：全局指示 + 每个工作区的 AGENTS.md、人设、项目与话题。 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { RotateCcw, Save } from 'lucide-react'
import { api } from './api.ts'
import { ItemList, type Item } from './Settings.tsx'
import { Field, Header, usePanel } from './ui.tsx'
import css from './pages.module.css'

type Ws = {
  path: string, default: boolean, groups: string[], agents: string, overridden: boolean,
  projects: Item[], assistTopics: Item[], prompts: { chat: string, task: string }, personaExtra: string,
}
type Overview = { items: Ws[], globalAgents: string }

export function Workspaces() {
  const { toast } = usePanel()
  const [data, setData] = useState<Overview>()
  const [globalAgents, setGlobalAgents] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [agents, setAgents] = useState('')
  const [cfg, setCfg] = useState<Ws | null>(null)
  const load = () => void api('/workspaces').then((d: Overview) => {
    setData(d)
    setGlobalAgents(d.globalAgents)
    if (sel == null || !d.items.some((w) => w.path === sel)) setSel(d.items[0]?.path ?? null)
  }).catch((e) => toast((e as Error).message))
  useEffect(() => { load() }, [])
  useEffect(() => {
    const w = data?.items.find((x) => x.path === sel)
    setAgents(w?.agents ?? '')
    setCfg(w ? { ...w } : null)
  }, [sel, data])
  if (!data) return null
  const saveAgents = async (path: string, content: string) => {
    try { await api('/workspaces/agents', { path, content }); toast('已保存，即时生效') } catch (e) { toast((e as Error).message) }
  }
  const saveConfig = async (reset = false) => {
    if (!cfg) return
    try {
      await api('/workspaces/config', reset
        ? { path: cfg.path, reset: true }
        : { path: cfg.path, projects: cfg.projects, assistTopics: cfg.assistTopics, prompts: cfg.prompts, personaExtra: cfg.personaExtra })
      load()
      toast(reset ? '已恢复跟随全局' : '已保存，即时生效')
    } catch (e) { toast((e as Error).message) }
  }
  const set = (patch: Partial<Ws>) => setCfg((c) => c ? { ...c, ...patch } : c)
  return (
    <>
      <Header title="工作区" sub="人设、项目、话题按工作区配置；默认工作区 = 全局默认，其他工作区覆盖它。群的归属在「会话」右侧面板配">
        {cfg && !cfg.default && <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => saveConfig(true)}>恢复跟随全局</Button>}
        {cfg && <Button size="sm" variant="primary" icon={<Save size={14} />} onClick={() => saveConfig(false)}>保存配置</Button>}
      </Header>
      <div className={css.page}><div className={css.narrow}>
        <section className={css.section}>
          <h4>全局指示 · 对所有会话生效</h4>
          <div className={css.hint}>dataDir/AGENTS.md，注入每个 agent session（含后台任务），叠加在工作区配置之上；保存即生效</div>
          <textarea className={css.input} rows={8} style={{ fontSize: 12 }} value={globalAgents} placeholder="# 全局规则&#10;（留空 = 不注入任何全局指示）" onChange={(e) => setGlobalAgents(e.target.value)} />
          <div style={{ marginTop: 8 }}><Button size="sm" variant="outline" icon={<Save size={14} />} onClick={() => saveAgents('', globalAgents)}>保存全局指示</Button></div>
        </section>
        <section className={css.section}>
          <h4>工作区</h4>
          <div className={css.feed}>
            {data.items.map((w) => (
              <button key={w.path} className={css.card} style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setSel(w.path)}>
                <div className={css.row}>
                  <strong>{w.default ? '默认工作区（全局）' : w.path}</strong>
                  {w.groups.length > 0 && <span className={css.muted}>{w.groups.length} 个会话</span>}
                  {!w.default && w.overridden && <span className={css.muted}>已独立配置</span>}
                </div>
                <div className={css.muted} style={{ fontSize: 12 }}>{w.path}{w.default ? '（未单独配置工作区的群都在这里）' : ''}</div>
              </button>
            ))}
          </div>
        </section>
        {cfg && (
          <>
            <section className={css.section}>
              <h4>{cfg.default ? '默认工作区（全局）' : '工作区'} · {cfg.path}</h4>
              {cfg.groups.length > 0 && <div className={css.hint}>使用中的会话：{cfg.groups.join('、')}</div>}
              {!cfg.default && !cfg.overridden && <div className={css.hint}>目前完全跟随全局默认；改了保存即成为独立配置</div>}
              <div className={css.label} style={{ marginTop: 8 }}>AGENTS.md</div>
              <div className={css.hint}>工作区目录里的文件，跑在这个工作区的 agent 按工作目录读到；保存即生效</div>
              <textarea className={css.input} rows={8} style={{ fontSize: 12 }} value={agents} placeholder="这个工作区的指示（文件不存在会创建）" onChange={(e) => setAgents(e.target.value)} />
              <div style={{ marginTop: 8 }}><Button size="sm" variant="outline" icon={<Save size={14} />} onClick={() => saveAgents(cfg.path, agents)}>保存到工作区</Button></div>
            </section>
            <section className={css.section}>
              <h4>人设 · 保存即生效，不用重启</h4>
              <div className={css.card}>
                <Field label="聊天 agent" hint="聊天 agent 系统提示的主体；清空保存 = 恢复内置版本">
                  <textarea className={css.input} rows={14} style={{ fontSize: 12 }} value={cfg.prompts?.chat ?? ''} onChange={(e) => set({ prompts: { chat: e.target.value, task: cfg.prompts?.task ?? '' } })} />
                </Field>
                <Field label="后台任务 agent" hint="任务 worker 的系统提示；清空保存 = 恢复内置版本">
                  <textarea className={css.input} rows={10} style={{ fontSize: 12 }} value={cfg.prompts?.task ?? ''} onChange={(e) => set({ prompts: { chat: cfg.prompts?.chat ?? '', task: e.target.value } })} />
                </Field>
                <Field label="人设附加" hint="追加到聊天 agent 系统提示末尾">
                  <textarea className={css.input} rows={5} value={cfg.personaExtra ?? ''} placeholder="" onChange={(e) => set({ personaExtra: e.target.value })} />
                </Field>
              </div>
            </section>
            <section className={css.section}>
              <h4>主人的项目 · 可主动答疑、修 bug、开 PR</h4>
              <ItemList items={cfg.projects ?? []} repo onChange={(v) => set({ projects: v })} />
            </section>
            <section className={css.section}>
              <h4>可以帮忙的话题 · 只在有把握时回答</h4>
              <ItemList items={cfg.assistTopics ?? []} repo={false} onChange={(v) => set({ assistTopics: v })} />
            </section>
          </>
        )}
      </div></div>
    </>
  )
}
