/**
 * Configuration schema for dsh-plugin-orange. Static fields come from the
 * cordis row; runtime-editable fields (groups, whitelist, dry-run, topics,
 * prompts) live in the SQLite `kv` table and are edited from the Web panel.
 */
import z from '@deepseek-ai/schemastery'

export interface SatoriEndpoint {
  /** HTTPS base of a Satori server, e.g. https://bot.example.com:41008/satori */
  endpoint: string
  token: string
}

export interface Config {
  dataDir: string
  workspace: string
  koishi: SatoriEndpoint
  crossgram: SatoriEndpoint
  /** classifierModel overrides llm.model for the wake classifier and the inbound screen only. */
  llm: { baseURL: string, apiKey: string, model: string, classifierModel?: string, provider: string, agentModel: string }
  /**
   * The bot's masters, as `platform:id` keys (`qq:<user_openid>` for the official
   * bot, `cg:<uid>` for the userbot). This is the only source of authority: group
   * owners/admins get none of it. Empty = nobody, so set it before relying on the
   * in-chat `/ai.*` admin commands (until then everything is panel-side).
   */
  admins: string[]
  /**
   * Where operational errors are reported in chat, same `platform:id` form.
   * Empty = log only, which is what a fresh install wants.
   */
  errorGroup: string
  agentPreset: string
  webToken?: string
}

export const Config: z<Config> = z.object({
  dataDir: z.string().required(),
  workspace: z.string().required(),
  koishi: z.object({ endpoint: z.string().required(), token: z.string().required() }),
  crossgram: z.object({ endpoint: z.string().required(), token: z.string().required() }),
  llm: z.object({
    baseURL: z.string().required(),
    apiKey: z.string().required(),
    model: z.string().default('deepseek/deepseek-v4-flash'),
    provider: z.string().default('orange-llm'),
    agentModel: z.string().default('deepseek/deepseek-v4-flash'),
  }),
  admins: z.array(String).default([]),
  errorGroup: z.string().default(''),
  agentPreset: z.string().default('orange'),
  webToken: z.string(),
}) as any

/** Per-conversation settings; key = conversation key `qq:<openid>` / `cg:<id>`. */
export interface GroupSettings {
  /** Agent may respond (mention / ai command / classifier). */
  whitelisted: boolean
  /** Messages are generated and logged but never delivered. */
  dryRun: boolean
  /** Classifier-driven proactive participation. */
  listen: boolean
  /**
   * Who may trigger the agent in this group (@ / 回复 / /ai): `all` (default,
   * missing = everyone the whitelist already allows), `groupAdmin` = 群主+群管理员,
   * `botAdmin` = 机器人管理员/开发者 only. The bot's own admins pass every mode;
   * the classifier (listen) is the bot's own choice and is never limited.
   */
  triggerLimit?: 'all' | 'groupAdmin' | 'botAdmin'
  /** Free-form domain tags shown to the classifier, e.g. 蔚蓝, 开发. */
  tags: string[]
  /** Human notes for the classifier/agent about this group. */
  note: string
  /** Peer conversation on the other platform (same physical group), for history merge. */
  peer?: string
}

/**
 * One repository of a project. A product often spans several repos (the main
 * repo plus a client/patcher per platform), and each of them is a place a bug
 * report can land in.
 */
export interface ProjectSub {
  /** Repo name, e.g. `crossgram-mithka`; this is what the classifier sees. */
  name: string
  /** `owner/name` on GitHub. */
  repo: string
  note?: string
  /** Extra words that mean this subproject in chat; keep them distinctive. */
  aliases?: string[]
}

export interface OwnProject {
  name: string
  aliases: string[]
  repo: string
  note: string
  /** Owner/org holding the subprojects; `org:` in repos.txt clones it to ~/workspace/<org>/<repo>. */
  org?: string
  /**
   * Sibling repos of the same product. They are summarized inside the project's
   * single line (never one prompt line each) and listed in full by the
   * `project_repos` tool.
   */
  subs?: ProjectSub[]
}

/**
 * How the bot words what it says. The main style is a *global* rule: it sits in
 * the chat agent's prompt, so the model writes in that register itself. The
 * sub-styles never reach the prompt — every `say` draws a random few and has a
 * cheap completion call rewrite that one message, which is what stops successive
 * messages from coming out worded the same way.
 */
export interface StyleSettings {
  /** Run the rewrite step before sending. The main style stays in the prompt either way. */
  enabled: boolean
  /** Global style requirement, always shown to the agent and always given to the rewrite. */
  main: string
  /** Pool drawn from per send; every entry reads as an optional hint (「如有需要，…」). */
  subs: string[]
  /** How many sub-styles one send draws (both clamped to the pool size). */
  pickMin: number
  pickMax: number
  /** Sampling temperature of the rewrite call; higher = more variety. */
  temperature: number
  /** Model for the rewrite; empty = the configured chat model. */
  model: string
}

/**
 * One 表情 category. The list is fully editable from the panel: it is what the
 * agent is told it may use, and what the import classifier has to choose from,
 * so adding a category immediately widens both.
 */
export interface StickerType {
  /** Stable slug stored on each sticker; rename the display name instead of this. */
  id: string
  /** Display name, e.g. 无语. */
  name: string
  /** What it means / when it fits. This is the text the agent reads. */
  desc: string
}

export interface StickerSettings {
  /** Categories offered to the classifier and listed to the agent. */
  types: StickerType[]
  /**
   * Chance (0-100) that the bot appends a 表情 to a segment it just finished
   * talking in. 0 = off. A segment is the bot's *own* burst of messages in one
   * conversation: every send restarts `autoGapMs`, and when that timer finally
   * fires the burst is over and this roll happens. A segment that already
   * carried a 表情 (the agent chose one itself) never gets a second one.
   */
  autoPercent: number
  /** Quiet time (ms) after the bot's last message before its segment counts as finished. */
  autoGapMs: number
  /** Type id the automatic 表情 is picked from (`general` = 通用); '' = same as off. */
  autoTag: string
  /** Stickers below this weight (0-100) are never picked without an explicit id. */
  minWeight: number
  /** Model for the import classification/description call; empty = the chat model. */
  model: string
}

export interface RuntimeSettings {
  groups: Record<string, GroupSettings>
  /** Owned projects (may ask, may fix/PR). */
  ownProjects: OwnProject[]
  /** Projects we can help with only when we find a confident answer. */
  assistTopics: { name: string, aliases: string[], note: string }[]
  /** Max proactive (unsolicited) sends per group per hour. */
  proactivePerHour: number
  /** Global kill switch for classifier-driven participation. */
  classifierEnabled: boolean
  /** Whether @-mentions wake the agent on the userbot (cg) side. The official
   *  bot side always treats @ as a trigger; off by default upstream because a
   *  shared userbot account cannot tell an @ from the admin talking to himself. */
  cgMentionTrigger: boolean
  /** Whether userbot sends carry the 🤖 prefix marker (shared-account disambiguation). */
  botEmojiPrefix: boolean
  /** Session idle reset (ms). */
  sessionIdleMs: number
  /** Triggers landing within this window (ms) merge into one agent turn; 0 = no waiting. */
  wakeMergeMs: number
  /**
   * Model tiers the main agent may pick for a background worker (`start_task`
   * tier): fast = 调研/快速响应, quality = 写代码/修 bug. Empty = the configured
   * agentModel, which is also what the default tier always uses.
   */
  taskModels: { fast: string, quality: string }
  /**
   * Model for the wake classifier and the inbound screen. Empty = the static
   * llm.classifierModel from the cordis patch (then llm.model).
   */
  classifierModel: string
  /** Extra persona text appended to the chat agent prompt. */
  personaExtra: string
  /**
   * Persona prompt overrides, editable from the panel so prompt tuning needs no
   * rebuild+redeploy. Empty string = the built-in text from prompts.ts, which
   * keeps code-side prompt improvements effective until the operator overrides.
   */
  prompts: { chat: string, task: string }
  /** Speaking style: one global main style plus per-send random sub-styles. */
  style: StyleSettings
  /** Sticker/表情 pool: the type list, the segment auto-表情 and the classifier model. */
  stickers: StickerSettings
}

/**
 * The categories the agent may tag a 表情 with. `id` is stable storage, `name`
 * is what people read, `desc` is what the model gets — see StickerSettings.
 */
export const DEFAULT_STICKER_TYPES: StickerType[] = [
  { id: 'general', name: '通用', desc: '没啥特定意义，随时发都是对的' },
  { id: 'speechless', name: '无语', desc: '表示无语、恼火等不满' },
  { id: 'wow', name: '惊了', desc: '表示惊讶、兴奋' },
  { id: 'confused', name: '疑惑', desc: '表示疑惑、不解' },
  { id: 'pitiful', name: '可怜', desc: '表示难过、不安、卖可怜、不好意思' },
  { id: 'humble', name: '卖菜', desc: '表示对自己的不自信（很多也是「可怜」）' },
  { id: 'close', name: '亲昵', desc: '表示和对方的亲昵' },
  { id: 'other', name: '其它', desc: '其它类型' },
]

/**
 * The pool the send-time rewrite draws from. Everything is phrased as
 * 「如有需要」 on purpose: the step exists to vary the wording, not to staple
 * every marker onto every sentence.
 */
export const DEFAULT_STYLE_SUBS = [
  '如有需要，可以用「瓦/呀/哇/哈？」等来软化语气',
  '如有需要，可以用「~」来表示拖长',
  '如有需要，可以在句尾用「——」来表示拖长',
  '如有需要，可以用（）来更贴近网络用语',
  '如有需要，可以用颜文字（不是 emoji）来更贴近网络用语',
  '如有需要，可以用「咕…/唔…」等来软化语气',
  '如有需要，可以省掉主语、只留关键词（「版本？」「截图看看」）',
  '如有需要，可以用「欸/哦哦/嗯」这类短促的词开头',
  '如有需要，可以把一句话拆成两口气，中间用空格断开',
  '如有需要，可以用反问代替陈述（「不是这样？」「真的假的」）',
  '如有需要，可以写得随手一点，比如把「在吗」写成「在嘛」这种同音字',
  '如有需要，可以用「emmm/呃/啊这」表示犹豫或者接不上话',
  '如有需要，可以用「好家伙/笑死」这类口头感叹，但只在这句话本来就是那个语气时用',
  '如有需要，可以在句尾留一个很短的自我修正（「…算了」「当我没说」），同样只在这句话本来就是那个语气时用',
]

export const DEFAULT_SETTINGS: RuntimeSettings = {
  /**
   * No conversation is whitelisted on a fresh install: every group is stored as a
   * name/id row only (nothing from it is archived, nobody is answered) until the
   * operator whitelists it — from the panel's 会话 page, or with `/ai.white add`
   * from a chat the bot master is in.
   */
  groups: {},
  ownProjects: [
    { name: 'CeleMod', aliases: ['celemod', 'cm', '蔚蓝mod管理器'], repo: 'std-microblock/CeleMod', note: 'Celeste mod manager (Tauri + Rust + Preact)' },
    {
      name: 'crossgram', aliases: ['crossgram'], repo: 'std-microblock/crossgram',
      note: 'MTProto relay bridging QQ etc. to Telegram clients (cordis monorepo)',
      org: 'crossgram-project',
      // The clients and platform patchers live in their own repos; questions about
      // them ("mithka 闪退") are still questions about crossgram.
      subs: [
        { name: 'crossgram-desktop', repo: 'crossgram-project/crossgram-desktop', note: 'desktop client', aliases: ['crossgram 桌面端'] },
        { name: 'crossgram-android', repo: 'crossgram-project/crossgram-android', note: 'Android client', aliases: ['crossgram 安卓'] },
        { name: 'crossgram-tdlib', repo: 'crossgram-project/crossgram-tdlib', note: 'semantic TDLib patcher + multi-platform builds', aliases: ['tdlib'] },
        { name: 'crossgram-telegram-x', repo: 'crossgram-project/crossgram-telegram-x', note: 'server-switch patcher for Telegram X', aliases: ['telegram x'] },
        { name: 'crossgram-unigram', repo: 'crossgram-project/crossgram-unigram', note: 'server-switch integration for Unigram', aliases: ['unigram'] },
        { name: 'crossgram-mithka', repo: 'crossgram-project/crossgram-mithka', note: 'server switching + direct downloads for Mithka', aliases: ['mithka'] },
        { name: 'website', repo: 'crossgram-project/website', note: 'product site, deploy handbook, client downloads (Astro)' },
      ],
    },
    { name: 'EverestUltra', aliases: ['EverestUltra', 'eveu', 'eu'], repo: 'std-microblock/EverestUltra', note: 'Faster-loading Everest fork; the short names eveu/eu only mean this in Celeste-related contexts' },
    { name: 'breeze-shell', aliases: ['breeze', 'breeze-shell', 'breeze shell'], repo: 'std-microblock/breeze-shell', note: 'Windows context menu replacement' },
  ],
  assistTopics: [
    { name: 'Everest', aliases: ['everest', '蔚蓝mod加载器'], note: 'Celeste mod loader (EverestAPI/Everest)' },
    { name: 'Celeste mods', aliases: ['蔚蓝mod', 'celeste mod', '地图'], note: 'any Celeste mod / map / crash log' },
  ],
  proactivePerHour: 6,
  classifierEnabled: true,
  cgMentionTrigger: true,
  botEmojiPrefix: false,
  sessionIdleMs: 2 * 3600_000,
  wakeMergeMs: 2000,
  taskModels: { fast: '', quality: '' },
  classifierModel: '',
  personaExtra: '',
  prompts: { chat: '', task: '' },
  style: {
    enabled: true,
    main: 'IM 交流风：每句话尽可能简短，可以用空格代替逗号、句号等，避免使用冗余专有名词，可以用「」作为引用，避免使用「不是…而是…」这类句式',
    subs: DEFAULT_STYLE_SUBS,
    pickMin: 1,
    pickMax: 3,
    temperature: 1,
    model: '',
  },
  stickers: {
    types: DEFAULT_STICKER_TYPES,
    autoPercent: 15,
    autoGapMs: 7_000,
    autoTag: 'general',
    minWeight: 0,
    model: '',
  },
}
