/** Right drawer: per-conversation switches, classifier profile, pairing, actions. */
import { useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { History, RotateCcw, Zap } from 'lucide-react'
import { api, ago, type Conv, type Group } from './api.ts'
import { ConvLink, Field, SessionLink, usePanel } from './ui.tsx'
import css from './Drawer.module.css'

export function ConvSettings({ conv, session }: { conv: Conv, session: string | null }) {
  const { reload, toast, go } = usePanel()
  const [g, setG] = useState<Group>(conv.settings)
  const [tags, setTags] = useState(conv.settings.tags.join(', '))
  const [note, setNote] = useState(conv.settings.note)
  const [peer, setPeer] = useState(conv.settings.peer ?? '')
  useEffect(() => { setG(conv.settings); setTags(conv.settings.tags.join(', ')); setNote(conv.settings.note); setPeer(conv.settings.peer ?? '') }, [conv.key, conv.settings])
  const save = async (patch: Partial<Group>) => {
    setG((cur) => ({ ...cur, ...patch }))
    try { await api('/group', { conv: conv.key, patch }); reload(); toast('已保存') } catch (e) { toast((e as Error).message) }
  }
  return (
    <aside className={css.drawer}>
      <section className={css.section}>
        <h4>响应</h4>
        <Field label="白名单" hint="允许 @、/ai、回复触发"><Switch label="白名单" checked={g.whitelisted} onChange={(v) => save({ whitelisted: v })} /></Field>
        <Field label="触发限制" hint="白名单下谁能触发（机器人管理员始终可以；旁听不受影响）">
          <select className={css.text} value={g.triggerLimit ?? 'all'} onChange={(e) => save({ triggerLimit: e.target.value as Group['triggerLimit'] })}>
            <option value="all">所有人</option>
            <option value="groupAdmin">仅群主 + 群管理员</option>
            <option value="botAdmin">仅机器人管理员/开发者</option>
          </select>
        </Field>
        <Field label="旁听" hint="分类器判断相关时主动参与"><Switch label="旁听" checked={g.listen} onChange={(v) => save({ listen: v })} /></Field>
        <Field label="Dry run" hint="照常思考，但不真正发出"><Switch label="Dry run" checked={g.dryRun} onChange={(v) => save({ dryRun: v })} /></Field>
      </section>
      <section className={css.section}>
        <h4>群画像</h4>
        <div className={css.label}>标签</div>
        <input className={css.text} value={tags} placeholder="蔚蓝, 开发（逗号分隔）" onChange={(e) => setTags(e.target.value)} onBlur={() => save({ tags: tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
        <div className={css.label}>备注</div>
        <textarea className={css.text} rows={3} value={note} placeholder="这个群主要聊什么，给分类器参考" onChange={(e) => setNote(e.target.value)} onBlur={() => save({ note })} />
      </section>
      <section className={css.section}>
        <h4>对端</h4>
        <div className={css.hint}>同一个群在另一个 bot 下的 id，会自动识别</div>
        <input className={css.text} value={peer} placeholder="cg:群号 / qq:openid" onChange={(e) => setPeer(e.target.value)} onBlur={() => save({ peer: peer.trim() || undefined })} />
        {g.peer && <div className={css.peer}>→ <ConvLink conv={g.peer} /></div>}
      </section>
      <section className={css.section}>
        <h4>操作</h4>
        <div className={css.actions}>
          <Button size="sm" variant="outline" icon={<Zap size={14} />} onClick={async () => { await api('/wake', { conv: conv.key, reason: '面板手动唤醒' }); toast('已唤醒') }}>唤醒 agent</Button>
          <Button size="sm" variant="outline" icon={<RotateCcw size={14} />} onClick={async () => { await api('/reset', { conv: conv.key }); toast('下次触发会新开 session') }}>重置 session</Button>
          <Button size="sm" variant="outline" icon={<History size={14} />} onClick={() => go({ tab: 'responses', conv: conv.key })}>响应记录</Button>
        </div>
      </section>
      <section className={css.section}>
        <h4>信息</h4>
        <dl className={css.kv}>
          <dt>key</dt><dd>{conv.key}</dd>
          <dt>session</dt><dd>{session ? <SessionLink id={session} label={session.slice(-12)} /> : '—'}</dd>
          <dt>最后消息</dt><dd>{ago(conv.lastTs)}</dd>
        </dl>
      </section>
    </aside>
  )
}
