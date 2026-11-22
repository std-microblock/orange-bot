/**
 * Token accounting of the bot's sessions: one `session/event` listener reads the usage every assistant step reports
 * and adds it to a per-day, per-kind, per-model counter (`OrangeStore.addUsage`). The kind is the session's role
 * (`router`, `worker`, `voice`, `other`), with `-subagent` for a subagent of one of them.
 *
 * @module dsh-plugin-orange/usage
 */

/** Usage fields of a step, as `TokenUsage` reports them. */
interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface StepUsage {
  model: string
  input: number
  cached: number
  output: number
}

/**
 * The usage of one session event, or undefined when it carries none.
 * @param event - a `session/event` payload.
 * @param fromStream - reads the last `usage` chunk of a stream record (`lastAssistantStreamChunk`).
 */
export function usageOf(event: unknown, fromStream: (stream: unknown) => UsageLike | undefined): StepUsage | undefined {
  const e = event as { type?: string; surfaceOp?: string; data?: { usage?: UsageLike; stream?: unknown; message?: { source?: { model?: string } } } }
  if (e?.type !== 'assistant/message' && e?.type !== 'assistant/attempt') return undefined
  if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') return undefined
  const usage = (e.type === 'assistant/message' ? e.data?.usage : undefined) ?? fromStream(e.data?.stream)
  if (usage === undefined) return undefined
  return {
    model: String(e.data?.message?.source?.model ?? 'unknown'),
    input: (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    cached: usage.cacheReadTokens ?? 0,
    output: usage.outputTokens ?? 0,
  }
}
