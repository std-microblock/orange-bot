/**
 * Configuration of the plugin row (zod, validated by cordis as a Standard Schema).
 *
 * The values here are the deployment's seeds: the persona texts, the owner, the project list and the per-chat
 * profiles can all be edited from the panel, and what the panel saves (the `settings` record of the `orange` storage
 * domain) wins over the seed field by field. An empty persona text means the built-in one (`persona.ts`), so prompt
 * improvements that ship with the code stay effective until an operator writes their own.
 *
 * @module dsh-plugin-orange/config
 */
import { z } from 'zod'

const route = z.object({ provider: z.string(), model: z.string() })

const subProject = z.object({
  name: z.string(),
  repo: z.string(),
  note: z.string().optional(),
  aliases: z.array(z.string()).optional(),
})

/** One of the owner's projects: the bot may collect bugs for it, fix it and open PRs. */
export const OwnProject = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  /** `owner/name` on GitHub. */
  repo: z.string(),
  note: z.string().default(''),
  /** Owner/org holding the sibling repos (workspace path `<workspace>/<org>/<repo>`). */
  org: z.string().optional(),
  /** Sibling repos of the same product (clients, patchers, website). */
  subs: z.array(subProject).optional(),
  /**
   * A private project: its name, aliases and repo may only be mentioned in the chats listed in `chats` (and in an
   * admin's direct chat). Anywhere else the leak guard holds the message back.
   */
  private: z.boolean().optional(),
  /** Chat keys (`bot|chat`) or bare platform chat ids where a private project may be discussed. */
  chats: z.array(z.string()).optional(),
})
export type OwnProject = z.output<typeof OwnProject>

/** A topic the bot may help with but does not own. */
export const AssistTopic = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  note: z.string().default(''),
})
export type AssistTopic = z.output<typeof AssistTopic>

/**
 * What the bot knows about one chat beyond the dispatch wake/reply mode: extra prompt text, a workspace directory
 * the workers of that chat work in (its `AGENTS.md` is read into their prompt), and which projects belong there.
 */
export const ChatProfile = z.object({
  /** Display name for the panel. */
  name: z.string().optional(),
  /** Extra persona text for this chat (router and workers alike). */
  prompt: z.string().optional(),
  /** Directory the workers of this chat should work in; its `AGENTS.md` is appended to their prompt. */
  workspace: z.string().optional(),
  /** Project names relevant here; empty = every project. */
  projects: z.array(z.string()).optional(),
})
export type ChatProfile = z.output<typeof ChatProfile>

const personaTexts = z.object({
  /** The router's persona (what the bot is like in chat); '' = built-in. */
  chat: z.string().default(''),
  /** The task workers' persona; '' = built-in. */
  task: z.string().default(''),
  /** Extra text for the voice session (dsh-plugin-orange-voice); '' = built-in. */
  voice: z.string().default(''),
})

const owner = z.object({
  /** How the bot calls its owner. */
  name: z.string().default('主人'),
  /** The owner's GitHub login, if the bot should know it. */
  github: z.string().optional(),
  /** Anything else the persona should say about the owner. */
  note: z.string().optional(),
})

export const Config = z.object({
  /**
   * The bot's admins: platform user ids, or `bot|user` to pin one bot. This is the only source of authority — chat
   * owners and admins get none of it. On QQ a person has a different openid in groups (`member_openid`) and in the
   * direct chat (`user_openid`): list both.
   */
  admins: z.array(z.string()).default([]),
  owner: owner.default({ name: '主人' }),
  persona: personaTexts.default({ chat: '', task: '', voice: '' }),
  projects: z.array(OwnProject).default([]),
  assistTopics: z.array(AssistTopic).default([]),
  /** Per-chat profiles keyed by chat key (`bot|chat`). */
  chats: z.record(z.string(), ChatProfile).default({}),
  /**
   * Model tiers a worker may switch to with `task_tier`: `fast` (research, quick answers), `quality` (code, PRs) and
   * `vision` (reading images). An absent tier keeps the worker's configured model.
   */
  taskModels: z.object({
    fast: route.optional(),
    quality: route.optional(),
    vision: route.optional(),
  }).default({}),
  memory: z.object({
    /** Facts of the chat (and global ones) shown in the prompt; the rest are a `memory` search away. */
    promptFacts: z.number().int().min(0).max(200).default(30),
  }).default({ promptFacts: 30 }),
  github: z.object({
    /** Poll the `gh` login's notifications and hand new feedback on linked PRs/issues to their task worker. */
    enabled: z.boolean().default(true),
    intervalMs: z.number().int().min(30000).default(120000),
  }).default({ enabled: true, intervalMs: 120000 }),
  guard: z.object({
    /** Refuse file/shell tool calls of IM sessions that touch the harness's own data and credentials. */
    enabled: z.boolean().default(true),
    /** Extra regular expressions (case-insensitive) of private paths or names. */
    patterns: z.array(z.string()).default([]),
  }).default({ enabled: true, patterns: [] }),
  leak: z.object({
    /** Hold back a message that names a private project in a chat it does not belong to. */
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
  /** Where the projects' repositories are checked out (shown by `project_repos`); a chat profile's workspace wins. */
  workspace: z.string().default('~/workspace'),
  /** Most characters of a chat workspace's AGENTS.md read into a worker prompt. */
  maxAgentsChars: z.number().int().min(0).default(16000),
  /**
   * Directory written by `scripts/migrate-from-v1.mjs`; read once at start (memory, user tags, stickers) and then
   * marked as imported in the `orange` storage domain.
   */
  importV1: z.string().optional(),
})
export type Config = z.output<typeof Config>
