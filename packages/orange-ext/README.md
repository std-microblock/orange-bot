# orange-ext（crossgram 侧的同伴插件）

crossgram 侧的同伴插件，坐在 satori-exporter 旁边，给橘波特补上 **Satori 元素模型表达不了**的东西：reaction、合并转发展开、撤回、表情（QQ 收藏夹）、结构化消息查询，以及一条**全量消息流**（Satori 的事件里没有账号自己发出的消息，而 userbot 用的正是主人自己的账号）。

它和 [dsh-plugin-orange](../dsh-plugin-orange) 通过 Bearer token 通信。

> **这个包属于 crossgram 自己的 monorepo**：包名 `@mtproto-relay/orange-ext`、依赖 `@mtproto-relay/bridge`（`workspace:*`），所以它**不在本仓库的 pnpm workspace 里**（根 `pnpm-workspace.yaml` 故意没列它）。用法是把 `packages/orange-ext` 整个放进 crossgram 的 `packages/` 下，再把它挂到 crossgram 的应用配置里。

## 装

```bash
# 在 crossgram monorepo 里
cp -r /path/to/orange-bot/packages/orange-ext <crossgram>/packages/orange-ext
cd <crossgram> && pnpm install        # workspace:* 会从 crossgram 里解析 @mtproto-relay/bridge
```

然后把插件挂到跑着 QQNT 适配器的那份应用配置里（crossgram 的插件行，名字 `orange-ext`）：

```yaml
orange-ext:
  token: <TOKEN>           # 必填；dsh 侧的 ORANGE_CROSSGRAM_TOKEN 要跟它一样
  platformId: qqnt         # 默认值，指向要服务的那个 crossgram 平台
  botPlatform: qq          # 该平台在 satori 侧注册的 bot 的 platform 名
```

外网访问只需放行 `/satori/v1/*`（事件、出站发送、下面的 internal 路由全走它），例如 Caddy：

```caddy
https://bot.example.com:41009 {
	@satori path /satori/v1/*
	handle @satori { reverse_proxy 127.0.0.1:3140 }
	respond 404
}
```

改完重启 crossgram（服务端插件没有 HMR）。

## HTTP 路由

全部骑在 Satori internal router 上：`POST {endpoint}/v1/internal/<botPlatform>/<selfId>/<method>`——server 按 URL 里的 platform/selfId 选 bot，再进本插件在该 bot 上注册的路由，所以同一服务器上多份 orange-ext（qqnt + lark 各一份）互不相撞。JSON 进 `{"ok":true,"result":…}` 出，未带 `Authorization: Bearer <token>` 一律 401，请求体上限 64KB。`<selfId>` 用 ready 帧里 login 的 `self_id`（userbot 是数字 QQ 号）。

| 路由 | 请求 | 响应 |
|---|---|---|
| `message.get` | `{channelId, messageId}` | 一条消息的渲染结果（含 `replyToId`、媒体解析后的 url、转发 bundle 的 locator） |
| `forward.get` | `{locator}` | 一个合并转发里的所有快照（嵌套转发各自带自己的 locator） |
| `history.list` | `{channelId, before?, limit?}` | 一页历史（最老在前，最多 100 条） |
| `conversation.get` | `{channelId}` | `{id, kind, title, avatar}` |
| `member.roles` | `{channelId}` | **只**返回群主/管理员（`{members: [{id, role, name}], total}`）；2000 人群不会整份传 |
| `reaction.set` | `{channelId, messageId, reactionKeys[]}` | 设置本账号的 reaction，回当前 reaction 列表 |
| `reaction.catalog` | `{channelId?}` | 可用 reaction 的 key / 标题 |
| `message.recall` | `{channelId, messageIds[]}` | 撤回（最多 10 条，撤回所有人） |
| `forward.send` | `{fromChannelId, messageIds[], toChannelId}` | 合并转发若干条消息（测试用，agent 也能用） |
| `sticker.packs` | `{}` | 这个账号能看到的全部表情包（QQ 收藏夹是 `qq-favorites`） |
| `sticker.list` | `{packId?}` | 收藏表情（默认）或某个包的内容；每张带 native reference（能原样发回成**真表情**）和 CDN 直链 |
| `sticker.asset` | `{providerId, stickerId}` | 表情字节（base64 兜底，单张上限 12MB） |
| `debug` | `{}` | `{seen, clients}`：收到过多少条事件、当前几个事件流连接 |

平台没有对应能力时该路由报 `unsupported`（例如某个适配器没有 `getHistory`），其它路由不受影响。

## 事件流

没有独立接口——事件骑在标准 Satori 事件 socket（`/v1/events`）上，以自定义 `orange-message` 事件 dispatch（`_payload` 携带 `conversation/message/outgoing`，下划线键免于 snake_case 转换，dsh 侧原样读）。多平台同服务器时，每条帧带 `platform` 标记，客户端各取各的。

- 流里**包含账号自己发的消息**（`outgoing: true`）：userbot 是主人的账号，机器人要能认出自己刚说的话，面板也要显示。
- **selfId 和 loginId 不是一回事**：消息/`@` 用平台的 opaque id，Satori API 认证用登录 id（userbot 的数字 QQ 号）；两者都由 satori-exporter 的 ready 帧报告。

## 安全提醒

- 这条事件流等价于**这个 QQ 账号能看到的全部消息**，`sticker.*` 还能把收藏夹整份倒出来。token 要当密码对待，只走 HTTPS。
- 能写进账号的只有三条：`reaction.set`、`message.recall`、`forward.send`；其余是只读查询。
- 插件的 `platformId` 决定它服务哪个平台会话，别在同一份配置里挂到别的账号上。

## 开发

- TypeScript 源码（`main` 直接指向 `src/index.ts`，由 crossgram 自己加载），没有构建步骤。
- 依赖 crossgram 的接口（`ctx.imPlatform` / `ctx.imSticker` / `platform.*` 那套能力位）。对不上新版 crossgram 时，通常是某个能力位改名，改 `src/index.ts` 里对应的 `route()` 即可，其它路由照旧。
- 改完重启 crossgram；`debug` 路由可以快速确认事件有没有在流动。

## 许可

[MIT](../../LICENSE) © 2026 MicroBlock
