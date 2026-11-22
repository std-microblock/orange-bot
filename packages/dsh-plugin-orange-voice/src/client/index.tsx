/**
 * Browser half of `dsh-plugin-orange-voice`: the panel's 小爱音箱 tab — connection, what the speaker heard and why
 * an utterance was dropped, what was spoken, a test box and the recover button.
 */
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState } from 'react'
import type { ClientContext, PanelClient, TabProps } from './panel.ts'

interface Heard { at: number; text?: string; via?: string; outcome: string; reason?: string; durationMs: number }
interface Status {
  speaker: { connected: boolean; remote?: string; connectedAt?: number; connects: number; device?: string; clientVersion?: string; recording: boolean; playing: string; speaking: boolean; lastError?: string; commands: number }
  gate: { window?: { via: string; msLeft: number; keyword?: string } }
  heard: Heard[]
  lastSpoken?: { text: string; at: number; engine: string }
  noiseFloor: number
  listening: boolean
  config: Record<string, unknown>
}

const OUTCOME: Record<string, string> = { delivered: '已交给橘波特', dropped: '没接', empty: '只听到唤醒词', error: '出错' }

function clock(at: number): string { return new Date(at).toLocaleTimeString() }

function SpeakerTab({ read, command, toast }: TabProps) {
  const [status, setStatus] = useState<Status | undefined>()
  const [text, setText] = useState('')
  const load = useCallback(async () => {
    try { setStatus(await read<Status>('')) } catch (error) { toast(String((error as Error).message)) }
  }, [read, toast])
  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => clearInterval(timer)
  }, [load])
  const run = async (body: unknown) => {
    try { toast((await command(body)).text) } catch (error) { toast(String((error as Error).message)) }
    void load()
  }
  if (status === undefined) return <div className="im-empty">加载中…</div>
  const s = status.speaker
  return (
    <div>
      <div className="im-card" style={{ marginBottom: 12 }}>
        <div className="im-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Tag tone={s.connected ? 'success' : 'danger'}>{s.connected ? '在线' : '离线'}</Tag>
          {s.connected && <span className="im-muted">{s.remote} · {s.device ?? '?'} · client {s.clientVersion ?? '?'} · 从 {s.connectedAt ? clock(s.connectedAt) : '?'} 起 · 连过 {s.connects} 次</span>}
          {s.recording && <Tag tone="info">收音中</Tag>}
          {status.listening && <Tag tone="warning">有人在说话</Tag>}
          {s.speaking && <Tag tone="info">正在念</Tag>}
          {status.gate.window && <Tag tone="success">窗口 {status.gate.window.via} {Math.round(status.gate.window.msLeft / 1000)}s</Tag>}
          <span className="im-muted">底噪 {status.noiseFloor}</span>
        </div>
        {s.lastError && <div className="im-muted" style={{ marginTop: 6 }}>最近错误：{s.lastError}</div>}
        {status.lastSpoken && <div style={{ marginTop: 6 }}>最近念的：{status.lastSpoken.text} <span className="im-muted">（{clock(status.lastSpoken.at)}，{status.lastSpoken.engine}）</span></div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <Input placeholder="让音箱念一句（测试）" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 300 }} />
          <Button size="sm" disabled={!s.connected} onClick={() => { if (text.trim()) void run({ action: 'speak', text }) }}>念</Button>
          <Button size="sm" variant="outline" disabled={!s.connected} onClick={() => { void run({ action: 'interrupt' }) }}>打断</Button>
          <Button size="sm" variant="outline" disabled={!s.connected} onClick={() => { if (confirm('重启音箱上的 client？')) void run({ action: 'recover' }) }}>重启 client</Button>
        </div>
      </div>
      <h4>最近听到的</h4>
      {status.heard.length === 0 && <div className="im-empty">还没有</div>}
      <table className="im-table">
        <tbody>
          {status.heard.map((h, i) => (
            <tr key={i}>
              <td className="im-muted">{clock(h.at)}</td>
              <td><Tag tone={h.outcome === 'delivered' ? 'success' : h.outcome === 'error' ? 'danger' : 'neutral'}>{OUTCOME[h.outcome] ?? h.outcome}</Tag></td>
              <td>{h.via ?? ''}</td>
              <td>{h.text ?? ''}</td>
              <td className="im-muted">{h.reason ?? ''} {(h.durationMs / 1000).toFixed(1)}s</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details style={{ marginTop: 12 }}>
        <summary className="im-muted">配置</summary>
        <pre style={{ fontSize: 12 }}>{JSON.stringify(status.config, null, 2)}</pre>
      </details>
    </div>
  )
}

export const name = 'dsh-plugin-orange-voice'

export function apply(ctx: ClientContext): void {
  ctx.inject(['imPanel'], (scoped) => {
    const panel = scoped.get('imPanel') as PanelClient
    scoped.effect(() => panel.tab({ id: 'orange-voice', title: '小爱音箱', order: 95, component: SpeakerTab }), 'orange voice tab')
  })
}
