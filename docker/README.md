# Docker 部署（可选）

三种部署方式里的一种，另外两种见 [`../scripts/README.md`](../scripts/README.md)：

| 模式 | 适合 | 命令 |
|---|---|---|
| `bare` | 直接装在主机（最简单） | `./scripts/deploy.sh --go` |
| `compose`（本目录） | 想全新建一套容器 | `cd docker && cp .env.example .env && docker compose up -d --build` |
| `container` | Docker 已经跑着，只想装进那个容器 | `./scripts/deploy.sh --go --container <ID/名字>` |

## compose 最短路径

```bash
cd docker
cp .env.example .env       # 填 LLM_BASE_URL / LLM_KEY / SATORI_TOKEN，AppID 那三样建完机器人再填
docker compose up -d --build
docker compose logs -f bot # 等出现带 token 的面板地址
```

- 面板：<http://127.0.0.1:3080>（只绑本机；要外网自己加反代）
- koishi：容器内 5140，宿主机 `${KOISHI_PORT}`（默认 5140）
- 卷：`koishi-data`（koishi 配置/数据）、`bot-dsh`（$DSH_HOME：profile 与插件）、`bot-workspace`（agent 工作区）——**这三个别省**，不然重启丢配置
- 改配置：改 `.env` 后 `docker compose up -d`；改 koishi 的 AppID/Secret 同理

## 装进已有容器（`--container`）

```bash
./scripts/deploy.sh --go --container my-koishi
```

它会先 `docker inspect` 探镜像/工作目录/用户，确认容器里有 Node，再 `docker exec` 装
koishi + `@satorijs/adapter-qq` + `@koishijs/plugin-server-satori`，把桥插件拷进
`/opt/orange/koishi-plugin-orange-bridge`，配置写到 `/opt/orange/koishi.yml`（已存在先备份）。
**不会 stop / rm 任何容器，也不会改你已有的配置。**

## 常见错误

- `docker compose up` 报 `服务 bot 端口被占用`：改 `.env` 里的 `BOT_PORT`/`KOISHI_PORT`。
- bot 容器日志一直 `events closed ... invalid token`：koishi 还没起来，或两边 `SATORI_TOKEN` 不一致。
- 容器重启后配置没了：卷没挂。检查 `docker compose config` 里的 volumes。
- `--container` 报 `容器里没有 node`：那个镜像里没 Node，换 `node:24-bookworm` 重建，或者用 bare 模式。
- 群里不回话：面板里 `admins`、白名单都还是空的 —— 新装默认谁都不理。

## 未验证

这份 compose 与两个 entrypoint **没有在本机跑过**（这台机器没装 Docker），只做了
YAML 解析、`bash -n` 语法检查与参数解析测试。第一次用请先 `docker compose config` 看一眼。
