# dsh-plugin-orange

橘波特在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) IM 宿主（`@deepseek-ai/dsh-im`）上的那部分"自己"：人设、知识、记忆和几道安全闸。会话本身不归它管——每个群一个路由 session、后台任务 worker 都是 [`dsh-im-dispatch`](https://github.com/std-microblock/dsh-im-extras/tree/main/packages/im-dispatch) 和 [`dsh-im-session-tasks`](https://github.com/std-microblock/dsh-im-extras/tree/main/packages/im-session-tasks) 开的，音箱会话是 [`dsh-plugin-orange-voice`](../dsh-plugin-orange-voice) 开的。这个插件只通过公开 API 给它们加东西。

## 它做什么

| 部分 | 接入点 | 说明 |
|---|---|---|
| 人设 | `ctx.systemPrompt.section('orange:persona', order 50)` | 对每个 `ctx.im.sessions` 托管的会话渲染：路由用聊天人设，worker 用任务人设，音箱会话再加语音附加段；后面跟主人、管理员、项目、本会话设置、认识的人、长期记忆。三段人设都能在面板里改，留空 = 内置文本 |
| 工具 | `ctx.tools.register` | `memory`、`user_tag`、`project_repos`、`task_link`、`task_tier`、`orange_chat`（见下） |
| 工具守卫 | `ctx.tools.guard` | IM 会话（含其子 agent）的 bash/pwsh/read/write/edit/glob/grep… 参数里碰到 harness 自己的存储与会话记录（`~/.dsh/storages|sessions|profiles|logs`）、凭据文件、进程环境变量、`*_TOKEN/KEY/SECRET` 变量就拒绝；`guard.patterns` 可加正则 |
| 私有项目防泄露 | `im/before-send` | `projects[].private: true` 的项目只能在 `projects[].chats` 列出的会话和管理员私聊里提；别处的消息（包括润色之后的）提到它的名字/别名/仓库就整条拦下，agent 收到 `dropped` 和原因 |
| 辱骂过滤 | `im/message`（prepend） | 只认确定是骂人的词，非管理员发的这种消息不唤醒任何会话 |
| 认识的人 | `im/stored` | 记下发送者的显示名（变了才写），面板和人设里用；`dev` 标签/备注由 `user_tag` 或面板维护 |
| 用量 | `session/event` | 每个托管会话每一步的 token 用量，按 天 × 类别（router/worker/voice，子 agent 带 `-subagent`）× 模型 累加 |
| GitHub 跟进 | `gh` CLI | 轮询宿主上 `gh` 登录账号的通知；worker 用 `task_link` 登记过的 PR/issue 有新评论/review，就 steer 给那个任务的 worker |
| v1 导入 | `importV1` 配置 | 读 `scripts/migrate-from-v1.mjs` 的导出（记忆、用户标签、表情库、项目设置），只导一次 |
| 面板 | `ctx.imPanel.tab`（可选） | 「记忆与用户」「橘波特」（人设/主人/项目/按会话设置）「用量」三个页签 |

存储：一个 `orange` storage domain（表 `memory`、`users`、`settings`、`usage`、`links`、`state`）。聊天消息本身存在 dsh-im 的 `im_messages` 里，这里不再存。

## 工具

| 工具 | 谁用 | |
|---|---|---|
| `memory` | 所有会话 | add / search / update / delete。作用域 `chat`（当前会话，默认）、`user:<平台用户 id>`、`project:<名字>`、`global`；别的会话的 `chat:` 事实永远看不见（管理员 `scope: all` 除外） |
| `user_tag` | 所有会话 | `dev` 标签与备注 |
| `project_repos` | 所有会话 | 主人的项目、每个子仓库和它在工作区里的路径（私有项目只在允许的会话里出现） |
| `task_link` | worker | 登记本任务开的 PR/issue，之后 GitHub 反馈会自动转回来 |
| `task_tier` | worker | 切到 `taskModels.fast/quality/vision` 配好的模型（`agent.model.select`），没配的档位不动 |
| `orange_chat` | 管理员触发 | 读/改当前会话的设置：附加人设、工作区目录、相关项目 |

路由 session 的工具由 dispatch 的 `tools.main` 白名单决定，想让路由也能用 `memory` 等，就把名字加进去（`deploy/cordis.patch.yml` 里已经加了）。

## 配置

| 字段 | 默认 | |
|---|---|---|
| `admins` | `[]` | 管理员的平台用户 id（或 `bot|id`）。唯一的权限来源；QQ 上同一个人在群里（`member_openid`）和私聊（`user_openid`）的 id 不同，两个都写 |
| `owner` | `{ name: '主人' }` | 主人的称呼、GitHub、补充说明 |
| `persona.chat/task/voice` | `''` | 人设种子，空 = 内置 |
| `projects` | `[]` | `{ name, aliases, repo, note, org?, subs?, private?, chats? }` |
| `assistTopics` | `[]` | 能帮忙但不负责的话题 |
| `chats` | `{}` | 按会话（chat key `bot|chat`）的 `{ name, prompt, workspace, projects }` |
| `taskModels` | `{}` | `{ fast?, quality?, vision? }`，每个是 `{ provider, model }` |
| `workspace` | `~/workspace` | 仓库检出的根目录（`project_repos` 显示的路径） |
| `memory.promptFacts` | `30` | 人设里带的事实条数 |
| `github.enabled / intervalMs` | `true` / 120000 | GitHub 跟进 |
| `guard.enabled / patterns` | `true` / `[]` | 工具守卫 |
| `leak.enabled` | `true` | 私有项目防泄露 |
| `maxAgentsChars` | `16000` | 会话工作区 `AGENTS.md` 读进 worker 人设的上限 |
| `importV1` | — | v1 导出目录 |

面板里保存的设置（`settings` 记录）逐字段覆盖这些种子；种子之后再改配置文件，面板里没动过的字段会跟着变。

## 按会话的工作区

v1 里每个群可以有自己的工作区目录（会话直接在那里跑）。dispatch 的 worker 工作目录是全局一个（`worker.cwd`），插件没法替它换，所以现在的做法是：会话设置里的 `workspace` 写进 worker 人设（"这个会话的工作区：…，先 cd 过去"），那个目录的 `AGENTS.md` 也读进去；`project_repos` 的路径同样以它为根。效果接近，但不再是硬隔离。

## 开发

在仓库根目录：`pnpm install`、`pnpm run harness`（生成 `tsconfig.harness.json`，需要构建过的 harness 和 dsh-im-extras，见根 README），然后 `pnpm --filter dsh-plugin-orange run typecheck | test | build`。`dist/` 与 `client/client.js` 是构建产物，不提交。
