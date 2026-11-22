# orange-bot（橘波特）

> Orange (橘波特): a QQ group chat bot on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)'s IM host (`dsh-im`). Every chat gets its own router session that decides when to speak and hands real work to background task workers; the bot keeps long-term memory about people and chats, knows its owner's projects, follows up on its PRs, speaks in a deliberately casual style, sends stickers — and can listen and talk through a XiaoAI speaker at home, on DeepSeek's ASR/TTS.

橘波特是个群友型的助手：被 @、被回复、私聊时它判断要不要说话、说什么；需要查证的事它不瞎猜，交给后台任务去翻源码、跑命令、提 PR，做完回来在群里说一句结论。

这个分支（`dsh-im`）是重写后的版本：会话、消息存储、润色、表情这些"通用 IM 机器人"的部分全部交给 dsh 官方的 IM 框架 [`dsh-im`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/experimental/im) 和 [`dsh-im-extras`](https://github.com/std-microblock/dsh-im-extras)，这个仓库只留下"橘波特自己"的东西。

## 架构

```
QQ 群 / 私聊 ── QQ 官方机器人 ── @deepseek-ai/cordis-plugin-im-adapter-qq（可选再加 Lark）
                                   │
                                   ▼
                     @deepseek-ai/dsh-im：准入（sources）、im_messages 存储、im/message 链、
                     托管会话、发送（im/before-send）、im_* 工具
                                   │
             ┌─────────────────────┼──────────────────────────────┐
             ▼                     ▼                              ▼
   dsh-im-dispatch           dsh-im-polish                  dsh-im-stickers
   每个会话一个路由 session    发送前按橘波特风格润色、        表情库：上传/收藏、视觉分类、
   （wakeMode mention/watch/   防重复                         send_sticker、自动补表情
   auto）+ 跨群 chronicle
             │
             ▼
   dsh-im-session-tasks：后台任务 worker（完整 shell / 文件 / 子 agent / PR）
                                   ▲
   dsh-plugin-orange ──────────────┤  人设（每个托管会话的 orange:persona 段）、长期记忆、用户标签、
                                   │  主人项目、GitHub 反馈转任务、模型档位、工具守卫、私有项目防泄露、
                                   │  用量统计、面板页签
   dsh-plugin-orange-voice ────────┘  小爱音箱：录音流 → VAD/唤醒 → DeepSeek ASR → 语音会话
                                      → speak → DeepSeek TTS → 音箱播放
   dsh-im-panel：Web GUI 里的运维面板（会话、任务、路由规则、chronicle + 上面各插件的页签）
```

## 包

| 包 | 说明 |
|---|---|
| [`packages/dsh-plugin-orange`](packages/dsh-plugin-orange) | 橘波特本体：人设/预设（面板可编辑）、`memory`/`user_tag`/`project_repos`/`task_link`/`task_tier`/`orange_chat` 工具、工具守卫、`im/before-send` 私有项目防泄露、用量、GitHub 跟进、按会话设置、v1 导入、面板「记忆与用户」「橘波特」「用量」 |
| [`packages/dsh-plugin-orange-voice`](packages/dsh-plugin-orange-voice) | 小爱音箱语音通道（DeepSeek ASR/TTS，音箱 client 不用改），面板「小爱音箱」 |
| [`deploy/`](deploy) | profile 模板（`cordis.patch.yml` + `package.json`）、环境变量模板、systemd 单元、`render-profile.mjs` |
| [`scripts/`](scripts) | `migrate-from-v1.mjs`（v1 数据导出）、类型检查/测试用的 harness 定位脚本、浏览器 bundle 构建 |

## 删掉了什么，为什么

| v1 里的 | 现在 | 为什么 |
|---|---|---|
| `packages/orange-ext`（crossgram 扩展）、`packages/koishi-plugin-orange-bridge`（koishi 扩展）、自写 Satori 客户端、双平台配对 | 删除；平台只用 dsh 自带的官方 QQ 适配器（可选 Lark） | userbot 和 koishi 两条链路都要额外的服务、凭据和反代；官方适配器直接连 QQ 开放平台，消息落在 dsh-im 的存储里 |
| 依赖非官方 bot 的功能：reaction、合并转发展开、QQ 收藏表情导入、群成员角色、`koishi 指令` 识别 | 删除 | 官方 QQ 机器人没有这些接口。管理员判断只认配置里的 `admins` |
| 旁听分类器（每条群消息一次小模型调用）、跨群动态 note、自动 dev 标签 | dispatch 的 `wakeMode`（mention/watch/auto）和 `replyMode`；跨群用 chronicle；dev 标签由 `user_tag` 工具和面板维护 | 分类器是 v1 最贵、最常误判的部分；dispatch 的路由自己读上下文决定，watch 模式还能按话题旁听 |
| 自建 SQLite 消息库（messages/media/responses/classifications/events） | dsh-im 的 `im_messages` + `im_receipts` | 一份存储；历史、搜索、图片/文件读取都是 dsh-im 的 `im_*` 工具 |
| 自写的每会话 chat session、唤醒合并、空闲重置、任务 worker 管理 | dsh-im-dispatch + dsh-im-session-tasks | 会话托管、持久投递、任务、路由规则都是框架的事 |
| `say` 工具 + stylize 润色 | 路由用 `router_reply`，worker 用 `im_reply`；润色是 dsh-im-polish（橘波特的主风格/子风格作为配置，`deploy/cordis.patch.yml`） | 发送统一走 `ctx.im.send`，润色挂在 `im/before-send` 上，所有会话都生效 |
| `stickers.ts` 表情库 | dsh-im-stickers（类型表沿用 v1，迁移脚本把库搬过去） | 同上 |
| 独立的 Orange 面板（会话、响应记录、任务、表情、设置…） | dsh-im-panel；橘波特只加「记忆与用户」「橘波特」「用量」三个页签 | 会话/任务/规则/润色/表情都已经有各自插件的页签 |
| 入站审查（关键词 + 一次小模型调用） | 只留关键词那一层（`im/message` 前置过滤）；其余靠人设里的硬规则 | 每条 @ 消息多一次模型调用不划算，路由本身就能决定沉默 |
| 每个群一个独立工作区（session 直接在那个目录跑） | 会话设置里的 `workspace` 写进 worker 人设，其 `AGENTS.md` 读进去 | dispatch 的 worker 工作目录是全局一个，插件不能替它换；效果接近，但不再是硬隔离 |
| 任务模型档位（`start_task` 的 `tier`） | worker 自己调 `task_tier` 切模型（`agent.model.select`） | dispatch 的 `create_task` 没有档位参数，切换放到 worker 开工时 |
| 小爱音箱：音箱自带 ASR（instruction 日志）+ `tts_play.sh`，语音伪装成主人私聊的一条消息 | 独立包 `dsh-plugin-orange-voice`：VM 收录音流自己做 VAD/唤醒，DeepSeek ASR/TTS；语音是 dsh-im 之外的来源，进一个自己托管的会话 | 见 [voice README](packages/dsh-plugin-orange-voice/README.md)；伪装成平台消息正是 v1 被动回复锚点 bug 的来源 |
| `deploy/Dockerfile`、v1 截图 | 删除 | 部署改为 systemd 直接跑 dsh fork（见下） |

## 部署

需要：一台 Linux（Node ≥ 24.9、pnpm 11）、一份**构建过**的 DeepSeek Harness（目前是带 IM 的 fork 分支 `feat/im-automation`）、[`dsh-im-extras`](https://github.com/std-microblock/dsh-im-extras) 和本仓库，一个 QQ 开放平台机器人（AppID/AppSecret，开通群聊和单聊）。

```bash
# 1. 三个仓库并排放，各自构建
git clone <harness fork> dsh && (cd dsh && pnpm install && pnpm build)          # 面板需要 apps/web 的构建产物
git clone https://github.com/std-microblock/dsh-im-extras && (cd dsh-im-extras && pnpm install && pnpm build)
git clone -b dsh-im https://github.com/std-microblock/orange-bot && (cd orange-bot && pnpm install && pnpm build)

# 2. 渲染 profile（把插件的 file: 路径写成绝对路径），装依赖
node orange-bot/deploy/render-profile.mjs --out ~/.dsh/profiles/orange
(cd ~/.dsh/profiles/orange && pnpm install)

# 3. 环境变量：照 deploy/orange.env.example 填 /etc/orange/orange.env（root:root 0600）
# 4. systemd：deploy/orange-bot.service（WorkingDirectory 指向 harness checkout）
sudo install -m 0644 orange-bot/deploy/orange-bot.service /etc/systemd/system/orange-bot.service
sudo systemctl daemon-reload && sudo systemctl enable --now orange-bot
```

`build` 脚本里的类型检查要找到 harness 和 extras：放在 `../dsh`/`../deepseek-harness` 和 `../dsh-im-extras` 就自动找到，否则写 `DSH_HARNESS_ROOT`/`DSH_IM_EXTRAS_ROOT` 或仓库根的 `.harness-root`/`.extras-root`（不提交）。

上线前：

1. `ORANGE_QQ_CHATS` 填要服务的群（`group:<group_openid>`）和主人私聊（`user:<user_openid>`）；留空 = 机器人所在的所有群和所有人的私聊都收。
2. `ORANGE_ADMINS` 填主人的 id。QQ 上同一个人在群里和私聊里 id 不同，两个都填；不确定的话先让主人在群里 @ 一次、私聊发一句，在面板「会话」或「记忆与用户」里看 id。
3. 模型路由：`ORANGE_PROVIDER` 和各个 `*_MODEL` 必须是 harness 里已配置的 provider/model。
4. 群的唤醒方式默认 `mention`（只有 @、回复机器人才唤醒）；想让橘波特旁听某个群，在面板「会话」页改成 `watch` 并写上旁听话题。QQ 官方机器人在群里只收得到 @ 它的消息，`watch`/`auto` 只对 Lark 之类能收全量消息的平台有意义。
5. 面板在 harness 的 Web GUI 里（侧栏面板列表，或 `#im`），GUI 只监听回环，用 SSH 隧道访问。

### 从 v1 迁移

```bash
node scripts/migrate-from-v1.mjs --qq-bot qq:<AppID>                 # 默认 dry run，只打印会导出什么
node scripts/migrate-from-v1.mjs --qq-bot qq:<AppID> --out ~/orange-v1-export --write
# 然后 ORANGE_IMPORT_V1=~/orange-v1-export，重启；插件导入一次（记忆、用户标签/备注、表情库、项目/人设/按群设置）
```

v1 的会话 key `qq:<openid>` 按 `conversations.direct` 映射成 `qq:<AppID>|group:<openid>` 或 `…|user:<openid>`，`user:qq:<id>` 映射成 `user:<id>`；userbot（`cg:`）的数据丢弃。聊天记录、响应记录、任务不迁。导入后建议在面板里抽查几条群记忆的会话 key 是否和新适配器的一致。

## 开发

```bash
pnpm install
pnpm typecheck   # 生成 tsconfig.harness.json，再 tsc 两个包（host 半与浏览器半）
pnpm test        # node --test，纯逻辑 + 假音箱/假 DeepSeek 服务的端到端
pnpm build       # dist/（tsc）+ client/client.js（esbuild，React 与 dsh 客户端模块由 GUI 提供）
```

插件只通过公开 API 接入：`ctx.im`、`ctx.systemPrompt`、`ctx.tools`、`ctx.storageDomain`、`ctx.imTasks`、`ctx.imPanel`、`ctx.imStickers`，不深层导入任何 `@deepseek-ai/*/src/...`；extras 只用到 `dsh-im-session-tasks` 的类型。提交格式 `scope: message`（`repo:`、`dsh:`、`voice:`、`deploy:`、`scripts:`）。

## 隐私与安全

- **只收准入的会话**：dsh-im 的 `sources`（`ORANGE_QQ_CHATS`）之外的消息不入库也不触发任何会话。
- **记忆按会话隔离**：`chat:` 作用域的事实只在那个会话里可见；人设里只带本会话和全局的事实。
- **工具守卫**：任何 IM 会话（含子 agent）的文件/shell 工具参数碰到 harness 的存储与会话记录、凭据文件、进程环境变量、`*_TOKEN/KEY/SECRET` 变量就直接拒绝并记日志。
- **私有项目**：`projects[].private` 的项目只在它的会话和管理员私聊里出现在人设里；别处的发送提到它就被拦下。
- **管理员只认配置**：群主、群管理员拿不到任何额外权限。
- **音箱**：协议无鉴权、`run_shell` 是 root，所以默认关闭、必须配 `allowFrom`；只有唤醒窗口内的话会被转写。
- 仓库公开：不提交群号、openid、AppID、key、内网地址；这些都只在 `/etc/orange/orange.env`。

## 许可

[MIT](LICENSE) © 2026 MicroBlock
