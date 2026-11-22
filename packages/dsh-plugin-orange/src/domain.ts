/**
 * The `orange` storage domain: the tables behind {@link OrangeStore}.
 *
 * @module dsh-plugin-orange/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryRecord, SettingsRecord, TaskLinkRecord, UsageRecord, UserRecord } from './store.ts'

const memory = z.looseObject({
  id: z.number(),
  scope: z.string(),
  text: z.string(),
  at: z.number(),
  from: z.exactOptional(z.string()),
})

const user = z.looseObject({
  id: z.string(),
  name: z.exactOptional(z.string()),
  tags: z.array(z.string()),
  note: z.exactOptional(z.string()),
  chat: z.exactOptional(z.string()),
  updatedAt: z.number(),
})

const settings = z.looseObject({ updatedAt: z.number() })

const usage = z.looseObject({
  day: z.string(),
  kind: z.string(),
  model: z.string(),
  calls: z.number(),
  input: z.number(),
  cached: z.number(),
  output: z.number(),
})

const link = z.looseObject({
  repo: z.string(),
  number: z.string(),
  kind: z.enum(['pr', 'issue']),
  task: z.number(),
  session: z.string(),
  at: z.number(),
  seen: z.exactOptional(z.string()),
})

const state = z.looseObject({ value: z.string() })

const as = <V>(schema: unknown) => schema as z.ZodType<V>

export const orangeDomain = defineDomain({
  name: 'orange',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    memory: domainTable<string, MemoryRecord>(as(memory)),
    users: domainTable<string, UserRecord>(as(user)),
    settings: domainTable<string, SettingsRecord>(as(settings)),
    usage: domainTable<string, UsageRecord>(as(usage)),
    links: domainTable<string, TaskLinkRecord>(as(link)),
    state: domainTable<string, { value: string }>(as(state)),
  },
})

export type OrangeDomain = Domain<typeof orangeDomain>
