#!/usr/bin/env bash
# bot 容器入口：把通用环境变量映射成插件要的名字，准备好 profile，然后起 dsh web。
set -euo pipefail

: "${DSH_HOME:=/data}"
export DSH_HOME
PATCH=/opt/orange-bot/packages/dsh-plugin-orange/cordis.patch.yml
PLUGIN_DIR=/opt/orange-bot/packages/dsh-plugin-orange

# 变量名不写死：从插件配置层里读，插件改名这里跟着走。
names="$(grep -oE 'process\.env\.[A-Z][A-Z0-9]*_[A-Z0-9_]*' "$PATCH" | sed 's/process\.env\.//' | awk '!seen[$0]++')"
[ -n "$names" ] || { echo "读不到 $PATCH 里的变量名" >&2; exit 1; }

for n in $names; do
  case "$n" in
    *_KOISHI_ENDPOINT) export "$n=${SATORI_URL:-http://koishi:5140/satori}" ;;
    *_KOISHI_TOKEN) export "$n=${SATORI_TOKEN:?SATORI_TOKEN 没给}" ;;
    *_CROSSGRAM_ENDPOINT) export "$n=http://127.0.0.1:9/satori" ;;   # 只接官方 bot，占位
    *CROSSGRAM*) export "$n=placeholder" ;;
    *_BASE_URL) export "$n=${LLM_BASE_URL:?LLM_BASE_URL 没给}" ;;
    *_API_KEY|*_KEY) export "$n=${LLM_KEY:?LLM_KEY 没给}" ;;
    *_DATA) export "$n=$DSH_HOME" ;;
    *_WORKSPACE) export "$n=${ORANGE_WS:-/workspace}" ;;
    *) : ;;
  esac
done

mkdir -p "$DSH_HOME" "${ORANGE_WS:-/workspace}"

# profile：只加依赖和 bundle，已有的键不动（重复启动幂等）
dsh --profile web --dump-config >/dev/null
node - "$DSH_HOME/profiles/web/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const name = 'dsh-plugin-orange'
const link = 'link:/opt/orange-bot/packages/dsh-plugin-orange'
pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies[name] = link
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
const bundles = pkg.dsh.profile.bundles ?? []
if (!bundles.includes(name)) bundles.push(name)
pkg.dsh.profile.bundles = bundles
pkg.dsh.profile.patchReload = pkg.dsh.profile.patchReload ?? 'live'
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
NODE

if [ ! -d "$DSH_HOME/profiles/web/node_modules/dsh-plugin-orange" ]; then
  (cd "$DSH_HOME/profiles/web" && pnpm install --silent)
fi

exec dsh web --host 0.0.0.0 --port "${BOT_PORT:-3080}" --no-open
