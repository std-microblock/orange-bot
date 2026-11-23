# 自部署脚本（只接 QQ 官方 bot）

一句话：`scripts/deploy.sh`（Linux / macOS）或 `scripts/deploy.ps1`（Windows）把
「装 dsh → 拉代码 → 构建插件 → 挂进 profile → 问出必填配置」一次做完，
剩下的只有「去 q.qq.com 建机器人」和「启动 koishi」两件事要你自己点。

> 只覆盖 **QQ 官方 bot** 这一条线。另一条 userbot 线要 crossgram 加一个注入 QQNT 的
> `qqnt-bridge` 本地服务，那个组件不在公开仓库里，脚本不碰。

## 用

Linux / macOS（Node ^22.19 或 >=24，git，npm）：

```bash
./scripts/deploy.sh            # 只打印用法，什么都不做
./scripts/deploy.sh --go       # 交互式：一步步问，密钥输入不回显
```

Windows（PowerShell 5.1+ 或 7）：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # 只在当前窗口生效
.\scripts\deploy.ps1           # 打印用法
.\scripts\deploy.ps1 -Go       # 交互式
```

无人值守（CI / 重装）：

```bash
./scripts/deploy.sh --yes \
  --llm-base-url https://api.deepseek.com/v1 --llm-key sk-... \
  --satori-token <自己编的长串> \
  --app-id 1020xxxx --app-secret <AppSecret> --bot-token <Token>
```

## 离线安装（网络差 / 没有 git）

```bash
./scripts/deploy.sh --go --source ~/Downloads/orange-bot-main.zip
./scripts/deploy.sh --go --source ~/src/orange-bot/          # 目录也行
./scripts/deploy.sh --yes --no-clone --source ~/src.tgz ...   # 明确不碰网络
```

- 认目录、`.zip`、`.tar.gz` / `.tgz` / `.tar`；解压前先看清单，**绝对路径或 `..` 条目直接拒绝**（防 zip-slip）；
- **不覆盖已有的 `--dir`**：目标非空就报错，让你换目录；
- 离线模式没有 `.git`：以后更新就再拿一份新压缩包，解到新目录、`--dir` 指过去（脚本不打 `git pull`）。

## 装进已有容器（`--container`）

```bash
./scripts/deploy.sh --go --container my-koishi
```

先 `docker inspect` 探镜像 / 工作目录 / 用户，确认容器里有 Node（没有就提示换 `node:24-bookworm`），
再 `docker exec` 装 koishi + `@satorijs/adapter-qq` + `@koishijs/plugin-server-satori`，
把桥插件拷进 `/opt/orange/koishi-plugin-orange-bridge`，配置写到 `/opt/orange/koishi.yml`
（**已存在先备份**，原文件不原地覆盖）。已经装过就跳过；**不 stop / rm 任何容器**。
它会检查容器有没有把 koishi 数据目录挂出来，没挂会提醒你（不然重启就丢）。

## 脚本做了什么

1. 检查 Node（`^22.19 || >=24`），不满足只提示怎么装，不替你装；
2. `npm i -g @deepseek-ai/dsh`（已经有了就跳过）；
3. clone / `fetch + merge --ff-only` 更新 orange-bot；
4. 在 `packages/dsh-plugin-orange` 里 `npm install`（`prepare` 会顺手 build）；
5. 生成/合并 `$DSH_HOME/profiles/web/package.json`：加 `link:` 依赖 + 把
   `dsh-plugin-orange` 加进 `bundles`（已经加过不会重复，其它字段原样保留）；
6. 从插件自带的配置层 `packages/dsh-plugin-orange/cordis.patch.yml` 里读变量名，
   把必填项问出来写进 `$DSH_HOME/.env`（权限 600，不进 git；`dsh` 启动时会自动加载）；
   已经存在的键**不动**；
7. 把 koishi 侧的插件片段写到 `$DSH_HOME/koishi-plugins.yml`（含 AppID/Secret/Token，600），
   `--skip-koishi` 可以跳过；
8. 打印下一步。

不 sudo、不装系统包、不改你已有的配置、不回显任何密钥。

## 要填的东西

变量名不写死——脚本从 `cordis.patch.yml` 里读，所以插件改名脚本也跟着走。要填的是这些用途：

| 用途 | 说明 |
|---|---|
| 数据目录 / 工作区 | 有默认值，脚本不打扰 |
| koishi 的 Satori 地址 | 默认 `http://127.0.0.1:5140/satori`，和 koishi 配置里的 `port` + `server-satori.path` 对上 |
| koishi 的 Satori 令牌 | 自己编一串，要和 koishi 里 `server-satori` / `orange-bridge` 的 `token` 一致 |
| crossgram 两项 | 只接官方 bot 时填占位即可，插件会一直重连告警，无害 |
| 模型端点 / 模型 key | 任意 OpenAI 兼容端点；分类器、聊天、任务、风格润色都走它 |
| AppID / AppSecret / Token | q.qq.com 建完机器人后拿，脚本只把它们写进 koishi 片段文件 |

改值：删掉 `$DSH_HOME/.env` 里对应那行再跑一次，或者直接编辑 `$DSH_HOME/koishi-plugins.yml`。

## 起服务

```bash
cd ~/koishi-bot && npm start     # 终端 A：koishi
dsh web                          # 终端 B：日志里有带 token 的面板地址
```

然后在面板里：`admins` 填 `qq:<你的 openid>` → 会话页把群加白名单 → 先开 dry run →
群里 @它 说一句 → 「响应记录」看它为什么醒。

## 常见错误

- **`MISSING_CREDENTIAL: 缺 ...`**：`--yes` 模式必须用参数给全必填项；先跑一次 `--go` 交互，或者补参数。
- **端口被占**：koishi 默认 5140，`dsh web` 也有自己的端口；改 koishi 的 `port` 时记得同步改 `.env` 里的 koishi 地址。
- **群里不回话**：新装的插件 `admins`、白名单都是空的 —— 不配就谁都不理；配了还要看群是不是在白名单里。
- **官方 bot 主动消息额度**：主动推送 2025-04-21 起停止提供，机器人只能被动回；群聊被动窗口 5 分钟、同一条消息最多回 5 次，超了就是 `msg limit exceed`。
- **Node 太老 / 找不到 dsh**：Node 升到 24；`npm i -g` 后 `dsh` 不在 PATH 就把 npm 的 bin 目录加进去。
- **没有 pnpm**：脚本会用 corepack 开，再不行 `npm i -g pnpm`。
- **`--source` 报「已存在且非空」**：脚本不覆盖已有目录，换 `--dir <新目录>` 或先备份移走。
- **`--source` 报「有绝对路径或 .. 条目」**：压缩包不干净，重新从 GitHub 下载，别用第三方打包。
- **`--container` 报 `容器里没有 node`**：那个镜像里没有 Node；换 `node:24-bookworm` 重建，或走 bare 模式。
- **容器重启配置没了**：koishi 的数据目录没挂卷，重建时加 `-v ...:/koishi`。

## 没覆盖 / 没验证

- 没有真连过 QQ（本机没有可用 AppID），QQ 侧的收发、被动回复、群授权**未覆盖**；
- Windows 版只做了语法解析，**没有在 Windows 真机上跑过**；
- koishi 本体和它的适配器要你自己装，脚本只生成插件片段，不写你的 `koishi.yml`；
- 面板里那些运行时设置（白名单、dry run、说话风格）脚本不碰。
