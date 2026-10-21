/** Global behaviour, projects and topics, persona. */
import { useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Braces, ChevronDown, ChevronRight, Plus, Save, Trash2 } from 'lucide-react'
import { api } from './api.ts'
import { Field, Header, usePanel } from './ui.tsx'
import css from './pages.module.css'

type Sub = { name: string, repo: string, aliases?: string[], note?: string }
type Item = { name: string, aliases: string[], repo?: string, note: string, org?: string, subs?: Sub[] }
/** Speaking style: one global main style, plus a pool the send-time rewrite draws from. */
type Style = { enabled: boolean, main: string, subs: string[], pickMin: number, pickMax: number, temperature: number, model: string }
/** The 表情 categories the agent may use and the import classifier picks from. */
type SType = { id: string, name: string, desc: string }
type Stickers = { types: SType[], autoPercent: number, autoGapMs: number, autoTag: string, minWeight: number, model: string }

const EMPTY_STYLE: Style = { enabled: true, main: '', subs: [], pickMin: 1, pickMax: 3, temperature: 1, model: '' }
const EMPTY_STICKERS: Stickers = { types: [], autoPercent: 15, autoGapMs: 7000, autoTag: 'general', minWeight: 0, model: '' }

/**
 * The 表情 type list. It is the whole vocabulary of the sticker feature: the
 * agent is told these names/meanings and the import classifier may only pick
 * from these ids, so adding one here immediately widens both. The id is the
 * stored value and must stay stable when the display name is reworded.
 */
function StickerCard({ value, onChange }: { value?: Partial<Stickers>, onChange: (v: Stickers) => void }) {
  const st: Stickers = { ...EMPTY_STICKERS, ...value }
  const set = (patch: Partial<Stickers>) => onChange({ ...st, ...patch })
  const types = st.types ?? []
  // The automatic 表情 is a type id, so it is a picker rather than free text: a
  // typo would silently mean "no 表情 ever", and the list is right below anyway.
  const pickable = types.some((t) => t.id === st.autoTag) || !st.autoTag
  return (
    <>
      <div className={css.card}>
        <div className={css.inline}>
          <span className={css.muted}>机器人自己说完一段话（静默</span>
          <input className={css.input} style={{ width: 64 }} type="number" min={1} value={Math.max(1, Math.round((st.autoGapMs || 7000) / 1000))} onChange={(e) => set({ autoGapMs: Math.max(1, Number(e.target.value)) * 1000 })} />
          <span className={css.muted}>秒算说完）后，有</span>
          <input className={css.input} style={{ width: 64 }} type="number" min={0} max={100} value={st.autoPercent} onChange={(e) => set({ autoPercent: Number(e.target.value) })} />
          <span className={css.muted}>% 概率自动补一张</span>
          <select className={css.input} style={{ width: 130 }} value={st.autoTag} onChange={(e) => set({ autoTag: e.target.value })}>
            {!pickable && <option value={st.autoTag}>{`（已删的 ${st.autoTag}）`}</option>}
            {types.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
          </select>
          <span className={css.muted}>类型的表情（0 = 关；这一段里机器人自己发过就不补）</span>
        </div>
        <div className={css.inline} style={{ marginTop: 8 }}>
          <span className={css.muted}>低于权重</span>
          <input className={css.input} style={{ width: 70 }} type="number" min={0} max={100} value={st.minWeight} onChange={(e) => set({ minWeight: Number(e.target.value) })} />
          <span className={css.muted}>的不自动挑 · 分类模型</span>
          <input className={css.input} value={st.model} placeholder="留空 = 默认模型" onChange={(e) => set({ model: e.target.value })} />
        </div>
      </div>
      <div className={css.feed} style={{ marginTop: 10 }}>
        {types.map((t, i) => (
          <div key={i} className={css.formGrid} style={{ gridTemplateColumns: '150px 1fr auto' }}>
            <input className={css.input} value={t.name} placeholder="类型名（无语）" onChange={(e) => set({ types: types.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
            <input className={css.input} value={t.desc} placeholder="含义 / 什么时候用（给 agent 和分类器看）" onChange={(e) => set({ types: types.map((x, j) => j === i ? { ...x, desc: e.target.value } : x) })} />
            <div className={css.inline} style={{ marginTop: 0 }}>
              <span className={css.muted}>{t.id}</span>
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => set({ types: types.filter((_, j) => j !== i) })} />
            </div>
          </div>
        ))}
        <div>
          <Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => set({ types: [...types, { id: `type${Date.now().toString(36).slice(-4)}`, name: '', desc: '' }] })}>添加类型</Button>
          <span className={css.subHint} style={{ marginLeft: 10 }}>改名随便改，id 是表情身上存的标记，一般不用动（删掉类型不会删表情，只是那些表情变成「未分类」）</span>
        </div>
      </div>
    </>
  )
}

/**
 * The style editor. Only the main style reaches the agent prompt; the pool below
 * is drawn from at random when a message is sent, which is what keeps successive
 * messages from sounding alike — so it is a list of 「如有需要」 hints, not rules.
 */
function StyleCard({ value, onChange }: { value?: Partial<Style>, onChange: (v: Style) => void }) {
  const st: Style = { ...EMPTY_STYLE, ...value }
  const set = (patch: Partial<Style>) => onChange({ ...st, ...patch })
  const subs = st.subs ?? []
  return (
    <>
      <div className={css.card}>
        <Field label="发送前润色" hint="每条消息发出前用「主风格 + 随机抽到的子风格」重写一遍；关掉就只按主风格，不再润色">
          <Switch label="润色" checked={st.enabled} onChange={(v) => set({ enabled: v })} />
        </Field>
        <Field label="主风格（全局）" hint="会进 agent 的系统提示，每条消息都遵守；子风格不进提示词，只在发送时随机抽">
          <textarea className={css.input} rows={3} value={st.main} onChange={(e) => set({ main: e.target.value })} />
        </Field>
        <div className={css.inline}>
          <span className={css.muted}>每次随机抽</span>
          <input className={css.input} style={{ width: 56 }} type="number" min={0} value={st.pickMin} onChange={(e) => set({ pickMin: Number(e.target.value) })} />
          <span className={css.muted}>~</span>
          <input className={css.input} style={{ width: 56 }} type="number" min={0} value={st.pickMax} onChange={(e) => set({ pickMax: Number(e.target.value) })} />
          <span className={css.muted}>条子风格 · 温度</span>
          <input className={css.input} style={{ width: 64 }} type="number" min={0} max={2} step={0.1} value={st.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} />
          <span className={css.muted}>· 润色模型</span>
          <input className={css.input} value={st.model} placeholder="留空 = 默认模型" onChange={(e) => set({ model: e.target.value })} />
        </div>
      </div>
      <div className={css.feed} style={{ marginTop: 10 }}>
        {subs.map((sub, i) => (
          <div key={i} className={css.formGrid} style={{ gridTemplateColumns: '1fr auto' }}>
            <textarea className={css.input} rows={2} value={sub} onChange={(e) => set({ subs: subs.map((x, j) => j === i ? e.target.value : x) })} />
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => set({ subs: subs.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <div><Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => set({ subs: [...subs, '如有需要，'] })}>添加子风格</Button></div>
      </div>
    </>
  )
}

/**
 * One card per project even when the product spans several repos: subprojects stay
 * collapsed behind a count. A product with a dozen clients and patchers would
 * otherwise bury the rest of the settings page (and the classifier prompt, which
 * only ever gets the project's single line).
 */
function ItemList({ items, repo, onChange }: { items: Item[], repo: boolean, onChange: (v: Item[]) => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const set = (i: number, patch: Partial<Item>) => onChange(items.map((x, j) => j === i ? { ...x, ...patch } : x))
  const subs = (p: Item) => p.subs ?? []
  const setSub = (i: number, k: number, patch: Partial<Sub>) => set(i, { subs: subs(items[i]).map((s, j) => j === k ? { ...s, ...patch } : s) })
  return (
    <div className={css.feed}>
      {items.map((p, i) => (
        <div key={i} className={css.card}>
          <div className={css.formGrid} style={repo ? undefined : { gridTemplateColumns: '1fr 1.6fr auto' }}>
            <input className={css.input} value={p.name} placeholder="名称" onChange={(e) => set(i, { name: e.target.value })} />
            {repo && <input className={css.input} value={p.repo ?? ''} placeholder="owner/repo" onChange={(e) => set(i, { repo: e.target.value })} />}
            <input className={css.input} value={p.aliases.join(', ')} placeholder="别名，逗号分隔" onChange={(e) => set(i, { aliases: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => onChange(items.filter((_, j) => j !== i))} />
            <input className={`${css.input} ${css.full}`} value={p.note} placeholder="说明（给分类器和 agent 看）" onChange={(e) => set(i, { note: e.target.value })} />
          </div>
          {repo && <>
            <div className={css.subHead}>
              <Button size="sm" variant="ghost" icon={open === i ? <ChevronDown size={14} /> : <ChevronRight size={14} />} onClick={() => setOpen(open === i ? null : i)}>
                {`子项目${subs(p).length ? ` · ${subs(p).length}` : ''}`}
              </Button>
              <input className={css.input} style={{ maxWidth: 240 }} value={p.org ?? ''} placeholder="子项目所在 org / owner" onChange={(e) => set(i, { org: e.target.value.trim() || undefined })} />
              <span className={css.subHint}>同一产品的其他仓库；只在这里展开，别处只占一行</span>
            </div>
            {open === i && <div className={css.subs}>
              {subs(p).map((s, k) => (
                <div key={k} className={css.formGrid}>
                  <input className={css.input} value={s.name} placeholder="子项目名" onChange={(e) => setSub(i, k, { name: e.target.value })} />
                  <input className={css.input} value={s.repo} placeholder="owner/repo" onChange={(e) => setSub(i, k, { repo: e.target.value })} />
                  <input className={css.input} value={(s.aliases ?? []).join(', ')} placeholder="别名" onChange={(e) => setSub(i, k, { aliases: e.target.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean) })} />
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => set(i, { subs: subs(p).filter((_, j) => j !== k) })} />
                  <input className={`${css.input} ${css.full}`} value={s.note ?? ''} placeholder="说明" onChange={(e) => setSub(i, k, { note: e.target.value })} />
                </div>
              ))}
              <div><Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => set(i, { subs: [...subs(p), { name: '', repo: '', aliases: [], note: '' }] })}>添加子项目</Button></div>
            </div>}
          </>}
        </div>
      ))}
      <div><Button size="sm" variant="outline" icon={<Plus size={14} />} onClick={() => onChange([...items, { name: '', aliases: [], note: '', ...(repo ? { repo: '' } : {}) }])}>添加</Button></div>
    </div>
  )
}

export function GlobalSettings() {
  const { reload, toast } = usePanel()
  const [s, setS] = useState<any>()
  const [raw, setRaw] = useState<string>()
  useEffect(() => { void api('/overview').then((o) => { const { groups: _g, ...rest } = o.settings; setS(rest) }) }, [])
  if (!s) return null
  const save = async () => {
    try { await api('/settings', raw !== undefined ? JSON.parse(raw) : s); reload(); toast('已保存') } catch (e) { toast((e as Error).message) }
  }
  return (
    <>
      <Header title="设置" sub="群级设置在「会话」里每个群的右侧面板">
        <Button size="sm" variant="ghost" icon={<Braces size={14} />} onClick={() => setRaw(raw === undefined ? JSON.stringify(s, null, 2) : undefined)}>{raw === undefined ? 'JSON' : '表单'}</Button>
        <Button size="sm" variant="primary" icon={<Save size={14} />} onClick={save}>保存</Button>
      </Header>
      <div className={css.page}>
        <div className={css.narrow}>
          {raw !== undefined ? <textarea className={css.input} style={{ height: '70vh', fontFamily: 'var(--dsw-font-family-mono, monospace)', fontSize: 12 }} value={raw} onChange={(e) => setRaw(e.target.value)} /> : <>
            <section className={css.section}><h4>行为</h4>
              <div className={css.card}>
                <Field label="分类器旁听" hint="总开关；关闭后只响应 @ / /ai / 回复"><Switch label="分类器" checked={s.classifierEnabled} onChange={(v) => setS({ ...s, classifierEnabled: v })} /></Field>
                <Field label="接受 @ 唤醒（userbot 侧）" hint="开启后群里 @ 机器人会直接唤醒 agent；官方 bot 侧不受此开关影响"><Switch label="@" checked={s.cgMentionTrigger} onChange={(v) => setS({ ...s, cgMentionTrigger: v })} /></Field>
                <Field label="🤖 发送前缀" hint="userbot 发的消息带 🤖 前缀（共号时区分人机）；独立机器人号建议关闭"><Switch label="前缀" checked={s.botEmojiPrefix} onChange={(v) => setS({ ...s, botEmojiPrefix: v })} /></Field>
                <Field label="每群每小时主动发言上限" hint="接话不计入"><input className={css.input} style={{ width: 90 }} type="number" min={0} value={s.proactivePerHour} onChange={(e) => setS({ ...s, proactivePerHour: Number(e.target.value) })} /></Field>
                <Field label="session 空闲重置（分钟）" hint="超时后下次触发新开 session"><input className={css.input} style={{ width: 90 }} type="number" min={5} value={Math.round(s.sessionIdleMs / 60000)} onChange={(e) => setS({ ...s, sessionIdleMs: Number(e.target.value) * 60000 })} /></Field>
                <Field label="消息合并窗口（毫秒）" hint="窗口内的 @ / 回复会合成一条消息发给 agent；agent 正在忙时也会等它说完再一起发"><input className={css.input} style={{ width: 90 }} type="number" min={0} step={100} value={s.wakeMergeMs ?? 2000} onChange={(e) => setS({ ...s, wakeMergeMs: Number(e.target.value) })} /></Field>
                <Field label="后台任务模型 · 快速" hint="主 agent 给调研/快速响应类任务（tier: fast）选的模型；空 = 跟随全局 agent 模型"><input className={css.input} style={{ width: 220 }} value={s.taskModels?.fast ?? ''} placeholder="deepseek/…" onChange={(e) => setS({ ...s, taskModels: { fast: e.target.value, quality: s.taskModels?.quality ?? '' } })} /></Field>
                <Field label="后台任务模型 · 高质量" hint="主 agent 给写代码/修 bug 类任务（tier: quality）选的模型；空 = 跟随全局 agent 模型"><input className={css.input} style={{ width: 220 }} value={s.taskModels?.quality ?? ''} placeholder="deepseek/…" onChange={(e) => setS({ ...s, taskModels: { fast: s.taskModels?.fast ?? '', quality: e.target.value } })} /></Field>
              </div>
            </section>
            <section className={css.section}><h4>说话风格 · 发送前用随机子风格润色</h4>
              <StyleCard value={s.style} onChange={(v) => setS({ ...s, style: v })} />
            </section>
            <section className={css.section}><h4>表情 · 类型、用量与自动分类</h4>
              <StickerCard value={s.stickers} onChange={(v) => setS({ ...s, stickers: v })} />
            </section>
            <section className={css.section}><h4>主人的项目 · 可主动答疑、修 bug、开 PR</h4><ItemList items={s.ownProjects} repo onChange={(v) => setS({ ...s, ownProjects: v })} /></section>
            <section className={css.section}><h4>可以帮忙的话题 · 只在有把握时回答</h4><ItemList items={s.assistTopics} repo={false} onChange={(v) => setS({ ...s, assistTopics: v })} /></section>
            <section className={css.section}><h4>人设 Prompt · 改完保存即生效，不用重启</h4>
              <div className={css.card}>
                <Field label="聊天 agent" hint="聊天 agent 系统提示的主体；保存后下一条消息就用新文本。清空保存 = 恢复内置版本">
                  <textarea className={css.input} rows={14} style={{ fontSize: 12 }} value={s.prompts?.chat ?? ''} onChange={(e) => setS({ ...s, prompts: { chat: e.target.value, task: s.prompts?.task ?? '' } })} />
                </Field>
                <Field label="后台任务 agent" hint="任务 worker 的系统提示；同样即时生效，清空保存 = 恢复内置版本">
                  <textarea className={css.input} rows={10} style={{ fontSize: 12 }} value={s.prompts?.task ?? ''} onChange={(e) => setS({ ...s, prompts: { chat: s.prompts?.chat ?? '', task: e.target.value } })} />
                </Field>
              </div>
            </section>
            <section className={css.section}><h4>人设附加</h4>
              <textarea className={css.input} rows={5} value={s.personaExtra} placeholder="追加到聊天 agent 系统提示末尾" onChange={(e) => setS({ ...s, personaExtra: e.target.value })} />
            </section>
          </>}
        </div>
      </div>
    </>
  )
}
