#!/usr/bin/env bash
# koishi 容器入口：按环境变量生成 /koishi/koishi.yml（已有就先备份），装好桥插件，起 koishi。
set -euo pipefail

: "${APP_ID:?APP_ID 没给}" "${APP_SECRET:?APP_SECRET 没给}" "${BOT_TOKEN:?BOT_TOKEN 没给}" "${SATORI_TOKEN:?SATORI_TOKEN 没给}"
KOISHI_HOME="${KOISHI_HOME:-/koishi}"
mkdir -p "$KOISHI_HOME"

if [ -f "$KOISHI_HOME/koishi.yml" ]; then
  cp -a "$KOISHI_HOME/koishi.yml" "$KOISHI_HOME/koishi.yml.bak.$(date +%Y%m%d-%H%M%S)"
  echo "已有 koishi.yml，已备份（原文件保留，本次会覆盖它）" >&2
fi

umask 077
cat > "$KOISHI_HOME/koishi.yml" <<YAML
port: 5140
plugins:
  adapter-qq:
    id: $APP_ID
    secret: $APP_SECRET
    token: $BOT_TOKEN
    type: private
    protocol: websocket
    sandbox: true
  server-satori:
    path: /satori
    token: $SATORI_TOKEN
  orange-bridge:
    path: /satori/orange
    token: $SATORI_TOKEN
YAML

# 桥插件装进 koishi 的 app 目录（本地目录依赖，不走网络）
(cd "$KOISHI_HOME" && npm install --no-audit --no-fund /opt/orange-bot/packages/koishi-plugin-orange-bridge)

cd "$KOISHI_HOME"
exec koishi start
