#!/usr/bin/env bash
# 橘波特（orange-bot）自部署脚本 —— 只接 QQ 官方 bot（koishi）这一条线。
#
# 做四件事：装 dsh、克隆/更新 orange-bot 并构建插件、把插件挂进 profile、
# 把必填配置问出来写进 $DSH_HOME/.env（600 权限，不进 git）。
#
# 不做的：不 sudo、不装系统包、不改你已有的配置、不打印任何密钥。
# 缺 Node 只提示怎么装，不替你装。
#
# 用法见 scripts/README.md，或 ./deploy.sh --help
set -euo pipefail

REPO_URL="${ORANGE_REPO_URL:-https://github.com/std-microblock/orange-bot}"
INSTALL_DIR="${ORANGE_INSTALL_DIR:-$HOME/orange-bot}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="web"
PLUGIN_NAME="dsh-plugin-orange"

MODE=""
ARG_LLM_URL=""
ARG_LLM_KEY=""
ARG_SATORI=""
ARG_APP_ID=""
ARG_APP_SECRET=""
ARG_BOT_TOK=""
SKIP_KOISHI=0
ARG_SOURCE=""
NO_CLONE=0
ARG_CONTAINER=""

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
橘波特自部署脚本（只接 QQ 官方 bot）

  ./deploy.sh                 打印本用法，什么都不做
  ./deploy.sh --go            交互式一步步来（推荐第一次用）
  ./deploy.sh --yes ...       无人值守，缺的必填项用参数给，缺一个就报 MISSING_CREDENTIAL

参数
  --go                    交互模式：每步会问你，密钥输入不回显
  -y, --yes               无人值守；必须同时给下面的必填参数
  --dir <路径>             orange-bot 检出目录（默认 ~/orange-bot）
  --dsh-home <路径>        dsh 的家目录（默认 $DSH_HOME 或 ~/.dsh）
  --llm-base-url <url>     OpenAI 兼容端点，例如 https://api.deepseek.com/v1
  --llm-key <key>          该端点的 key
  --satori-token <串>      koishi 侧 Satori 服务的 token（自己编，两边一致）
  --app-id <id>            q.qq.com 机器人 AppID
  --app-secret <secret>    机器人 AppSecret
  --bot-token <token>      机器人 Token
  --skip-koishi            不问 AppID/Secret/Token（之后自己填 koishi.yml）
  --source <路径>          不从 GitHub clone：用本地目录或 .zip/.tar.gz/.tgz/.tar 装
                           （网络差、或已经把仓库下成压缩包时用；不会覆盖已有的 --dir）
  --no-clone               同 --source 一起用：明确表示完全不碰网络（缺 --source 就报错）
  --container <ID|名>      不新建容器：在已有的 Docker 容器里装 koishi + adapter-qq + 橘波特的桥
                           （不 stop/rm 容器；写配置前先备份；重复跑不会重复装）

做完的下一步（脚本最后也会再打一遍）：
  1. 去 q.qq.com 建机器人拿 AppID / AppSecret / Token
  2. 把脚本生成的 koishi 插件片段贴进 koishi 的配置并启动 koishi
  3. 群主/管理员把机器人拉进群
  4. 群里 @它 说一句，面板「响应记录」里看它为什么醒
EOF
}

need_value() {
  # need_value <名字> <已有值>：--yes 模式下缺值直接报错
  local label="$1" value="$2"
  [ -n "$value" ] && return 0
  die "MISSING_CREDENTIAL: 缺 ${label}（--yes 模式必须用参数给全，或者先跑 --go 交互一遍）"
}

ask() {
  # ask <变量名> <默认值> [secret]
  local name="$1" def="$2" secret="${3:-}" answer=""
  if [ "$MODE" = "go" ] && [ "$secret" = "secret" ]; then
    printf '%s（输入不回显）: ' "$name" >&2
    IFS= read -rs answer || true
    printf '\n' >&2
  elif [ "$MODE" = "go" ]; then
    if [ -n "$def" ]; then
      printf '%s [%s]: ' "$name" "$def" >&2
    else
      printf '%s: ' "$name" >&2
    fi
    IFS= read -r answer || true
  fi
  [ -n "$answer" ] || answer="$def"
  printf '%s' "$answer"
}

# ---------- 参数 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --go) MODE="go" ;;
    -y|--yes) MODE="yes" ;;
    --dir) INSTALL_DIR="${2:?--dir 需要一个路径}"; shift ;;
    --dsh-home) DSH_HOME_DIR="${2:?--dsh-home 需要一个路径}"; shift ;;
    --llm-base-url) ARG_LLM_URL="${2:-}"; shift ;;
    --llm-key) ARG_LLM_KEY="${2:-}"; shift ;;
    --satori-token) ARG_SATORI="${2:-}"; shift ;;
    --app-id) ARG_APP_ID="${2:-}"; shift ;;
    --app-secret) ARG_APP_SECRET="${2:-}"; shift ;;
    --bot-token) ARG_BOT_TOK="${2:-}"; shift ;;
    --skip-koishi) SKIP_KOISHI=1 ;;
    --source) ARG_SOURCE="${2:?--source 需要一个路径}"; shift ;;
    --no-clone) NO_CLONE=1 ;;
    --container) ARG_CONTAINER="${2:?--container 需要容器 ID 或名字}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "未知参数：$1" ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  usage
  exit 0
fi

# --container 要在动手之前就确认 docker 在，免得白 clone 一次
if [ -n "$ARG_CONTAINER" ] && ! command -v docker >/dev/null 2>&1; then
  die "没找到 docker 命令。--container 要在装了 Docker CLI 的宿主机上用；没有 Docker 就走 bare 模式（不加 --container）"
fi

# ---------- 1. Node ----------
say "检查 Node（要 ^22.19 或 >=24）"
if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'
没找到 node。装法二选一（都不需要 sudo 的话优先用 nvm）：
  nvm:        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 24
  Debian/Ubuntu（要 sudo）:
              curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
装完重新开一个 shell 再跑本脚本。
EOF
  exit 2
fi
node_ok="$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a===22&&b>=19)||a>=24 ? "1":"0"')"
if [ "$node_ok" != "1" ]; then
  die "Node $(node -v) 太老：要 ^22.19 或 >=24（插件用 node:sqlite，没有原生依赖但需要新 API）"
fi
say "Node $(node -v) OK"

# ---------- 2. dsh ----------
if ! command -v dsh >/dev/null 2>&1; then
  say "安装 @deepseek-ai/dsh"
  if ! npm install -g @deepseek-ai/dsh; then
    die "全局安装失败。常见原因：npm 前缀没有写权限。可以：npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\" 后再跑"
  fi
fi
command -v dsh >/dev/null 2>&1 || die "装完还是找不到 dsh，检查 PATH"
say "dsh $(dsh --version 2>/dev/null || echo '(版本未知)')"

# ---------- 3. 取代码：clone / 本地目录 / 本地压缩包 ----------
SRC_TMP=""
cleanup_src() { [ -n "$SRC_TMP" ] && rm -rf "$SRC_TMP" || true; }
trap cleanup_src EXIT

# 清单检查：绝对路径、或任何 .. 段，一律拒绝（zip-slip / tar 穿越）
assert_safe_listing() {
  local archive="$1" listing
  case "$archive" in
    *.zip)
      command -v unzip >/dev/null 2>&1 || die "解 .zip 需要 unzip（apt install unzip / brew install unzip）"
      listing="$(unzip -Z1 "$archive")" ;;
    *) listing="$(tar -tzf "$archive")" ;;
  esac
  if printf '%s\n' "$listing" | grep -qE '(^/|(^|[[:space:]/])\.\.(/|$))'; then
    die "压缩包里有绝对路径或 .. 条目，拒绝解压：$archive"
  fi
}

install_from_source() {
  local src="$1" root
  SRC_TMP="$(mktemp -d "${TMPDIR:-/tmp}/orange-src.XXXXXX")"
  if [ -d "$src" ]; then
    say "从本地目录取代码：$src"
    cp -a "$src/." "$SRC_TMP/"
  elif [ -f "$src" ]; then
    case "$src" in
      *.zip|*.tar.gz|*.tgz|*.tar) ;;
      *) die "--source 只认目录、.zip、.tar.gz/.tgz/.tar：$src" ;;
    esac
    assert_safe_listing "$src"
    say "解压：$src"
    case "$src" in
      *.zip) unzip -q "$src" -d "$SRC_TMP" ;;
      *) tar -xzf "$src" -C "$SRC_TMP" ;;
    esac
  else
    die "找不到 --source：$src"
  fi

  # 压缩包通常多一层顶层目录：只有一个目录时进去
  root="$SRC_TMP"
  if [ "$(find "$SRC_TMP" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then
    local only
    only="$(find "$SRC_TMP" -mindepth 1 -maxdepth 1)"
    [ -d "$only" ] && root="$only"
  fi
  [ -f "$root/packages/$PLUGIN_NAME/package.json" ] || die "这份源码里没有 packages/$PLUGIN_NAME，路径不对？"

  # 不覆盖已有内容
  if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
    die "$INSTALL_DIR 已存在且非空；离线安装请换 --dir <新目录>（脚本不会覆盖已有目录）"
  fi
  mkdir -p "$INSTALL_DIR"
  cp -a "$root/." "$INSTALL_DIR/"
  say "已就位：$INSTALL_DIR（离线模式，没有 .git）"
}

if [ -n "$ARG_SOURCE" ]; then
  install_from_source "$ARG_SOURCE"
  warn "离线模式：以后更新就再下一份压缩包，解到新目录后用 --dir 指过去（或自己备份后覆盖），没有 git pull 这条路"
elif [ "$NO_CLONE" = "1" ]; then
  die "--no-clone 要和 --source <目录或压缩包> 一起用"
elif [ -d "$INSTALL_DIR/.git" ]; then
  say "更新 $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD >/dev/null
else
  say "克隆 orange-bot 到 $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
PLUGIN_DIR="$INSTALL_DIR/packages/$PLUGIN_NAME"
[ -f "$PLUGIN_DIR/package.json" ] || die "没找到 $PLUGIN_DIR/package.json，仓库结构变了？"


# ---------- 容器模式：装进已有容器（不碰容器生命周期）----------
container_install() {
  local cid="$1"
  command -v docker >/dev/null 2>&1 || die "没找到 docker 命令。--container 要在宿主机上用；没有 Docker 就走 bare 模式（不加 --container）"
  docker inspect "$cid" >/dev/null 2>&1 || die "docker inspect 找不到容器：$cid（docker ps 看一眼名字/ID）"

  local image workdir user
  image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
  workdir="$(docker inspect -f '{{.Config.WorkingDir}}' "$cid")"
  user="$(docker inspect -f '{{.Config.User}}' "$cid")"
  say "容器 $cid：镜像 ${image:-未知}，工作目录 ${workdir:-/}，运行用户 ${user:-root(默认)}"

  if ! docker exec "$cid" sh -lc 'command -v node >/dev/null 2>&1'; then
    die "容器里没有 node。换 node:24-bookworm 这类带 Node 的镜像重建容器，或改用 bare 模式：不加 --container"
  fi
  local nodev
  nodev="$(docker exec "$cid" sh -lc 'node -v' | tr -d '\r')"
  say "容器内 Node：$nodev"
  case "$nodev" in
    v22.1[9-9]|v22.[2-9]*|v2[4-9].*|v3[0-9].*) ;;
    *) warn "容器内 Node $nodev 偏旧（橘波特本体要 ^22.19 || >=24）；koishi 本身可能还能跑，但插件容器建议单独用 node:24" ;;
  esac

  # 幂等：已有 koishi 就跳过全局安装
  if docker exec "$cid" sh -lc 'command -v koishi >/dev/null 2>&1'; then
    say "容器里已经有 koishi，跳过全局安装"
  else
    say "在容器里装 koishi + adapter-qq + server-satori（npm i -g，可能要几分钟）"
    docker exec "$cid" sh -lc 'npm i -g koishi @satorijs/adapter-qq @koishijs/plugin-server-satori' \
      || die "容器内 npm 安装失败。可以先进去看：docker exec -it $cid sh"
  fi

  # 桥插件：从宿主机拷进去，再装进 koishi 的 app 目录
  local bridge_src="$INSTALL_DIR/packages/koishi-plugin-orange-bridge"
  [ -d "$bridge_src" ] || die "宿主机上没找到 $bridge_src（先让本脚本把源码准备好）"
  docker exec "$cid" sh -lc 'mkdir -p /opt/orange' || die "容器内建目录失败（权限？用 root 用户跑 docker）"
  docker cp "$bridge_src" "$cid:/opt/orange/koishi-plugin-orange-bridge" >/dev/null
  say "桥插件已拷进容器：/opt/orange/koishi-plugin-orange-bridge"

  # 配置：写之前先备份，绝不 in-place 覆盖
  local cfg="/opt/orange/koishi.yml"
  if docker exec "$cid" sh -lc "test -f $cfg"; then
    local stamp
    stamp="$(date +%Y%m%d-%H%M%S)"
    docker exec "$cid" sh -lc "cp -a $cfg $cfg.bak.$stamp" \
      && warn "容器里已有 $cfg，已备份成 $cfg.bak.$stamp（原文件没被改）"
  fi

  local app_id app_secret bot_token satori_token
  app_id="$(ask QQ_APP_ID "${ARG_APP_ID:-}")"
  app_secret="$(ask QQ_APP_SECRET "${ARG_APP_SECRET:-}" secret)"
  bot_token="$(ask QQ_BOT_TOKEN "${ARG_BOT_TOK:-}" secret)"
  satori_token="$(ask KOISHI_SATORI_TOKEN "${ARG_SATORI:-}" secret)"
  need_value QQ_APP_ID "$app_id"
  need_value QQ_APP_SECRET "$app_secret"
  need_value QQ_BOT_TOKEN "$bot_token"
  need_value KOISHI_SATORI_TOKEN "$satori_token"

  local tmpcfg
  tmpcfg="$(mktemp "${TMPDIR:-/tmp}/koishi.XXXXXX.yml")"
  umask 077
  cat > "$tmpcfg" <<EOF
# 由 orange-bot/scripts/deploy.sh --container 生成；密钥在这里，别提交进 git
port: 5140
plugins:
  adapter-qq:
    id: $app_id
    secret: $app_secret
    token: $bot_token
    type: private
    protocol: websocket
    sandbox: true
  server-satori:
    path: /satori
    token: $satori_token
  orange-bridge:
    path: /satori/orange
    token: $satori_token
EOF
  docker cp "$tmpcfg" "$cid:$cfg" >/dev/null
  rm -f "$tmpcfg"
  docker exec "$cid" sh -lc "chmod 600 $cfg" || true
  say "配置写进容器：$cfg"

  # 卷提醒：没有挂载的话重启就丢
  local mounts
  mounts="$(docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "$cid")"
  if [ -n "$mounts" ]; then
    printf '   容器现有挂载：\n%s\n' "$mounts" | sed 's/^/   /'
  fi
  if ! printf '%s' "$mounts" | grep -q '/koishi\|/opt/orange'; then
    warn "这个容器看起来没把 koishi 的数据目录挂出来：重启容器配置就丢。建议重建时加 -v \$PWD/koishi:/koishi（或者 docker cp 出来备份）"
  fi

  cat <<EOF

==> 容器模式装完了。剩下的：

  1. 起 koishi（在容器里）：docker exec -it $cid sh -lc 'cd /opt/orange && koishi start'
     想让它常驻就把这条写进容器的 entrypoint / compose command
  2. 宿主机上跑橘波特本体：不加 --container 再跑一次本脚本（bare 模式），
     koishi 地址填 http://<容器IP或127.0.0.1>:5140/satori，token 用刚才那串
  3. 群授权、拿 AppID 这些还是得在 q.qq.com 上做，脚本帮不了

  注意：脚本没有 stop / rm 任何容器；已有的 koishi 配置只备份不改。
EOF
}

if [ -n "$ARG_CONTAINER" ]; then
  container_install "$ARG_CONTAINER"
  exit 0
fi

# ---------- 4. 装依赖并构建 ----------
say "安装插件依赖并构建（npm install 会顺手跑一次 build）"
(cd "$PLUGIN_DIR" && npm install --no-audit --no-fund)
[ -f "$PLUGIN_DIR/lib/index.js" ] || die "构建没产出 lib/index.js，看上面的报错"

# ---------- 5. 挂进 profile ----------
say "准备 dsh profile：$DSH_HOME_DIR/profiles/$PROFILE"
DSH_HOME="$DSH_HOME_DIR" dsh --profile "$PROFILE" --dump-config >/dev/null
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
[ -f "$PROFILE_DIR/package.json" ] || die "profile 没生成：$PROFILE_DIR/package.json 不存在"

node - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" "$PLUGIN_NAME" <<'NODE'
const fs = require('node:fs')
const [file, pluginDir, name] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
const link = 'link:' + pluginDir
if (pkg.dependencies[name] !== link) pkg.dependencies[name] = link
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
const bundles = pkg.dsh.profile.bundles ?? []
if (!bundles.includes(name)) bundles.push(name)
pkg.dsh.profile.bundles = bundles
pkg.dsh.profile.patchReload = pkg.dsh.profile.patchReload ?? 'live'
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log(`profile 已挂上 ${name}（bundles: ${bundles.join(', ')}）`)
NODE

if ! command -v pnpm >/dev/null 2>&1; then
  say "没有 pnpm，试 corepack 开一下"
  corepack enable 2>/dev/null || true
  command -v pnpm >/dev/null 2>&1 || npm install -g pnpm
fi
(cd "$PROFILE_DIR" && pnpm install --silent)

# ---------- 6. 必填配置 ----------
# 变量名不写死：从插件自带的配置层里读，插件改名脚本也跟着走。
PATCH_FILE="$PLUGIN_DIR/cordis.patch.yml"
[ -f "$PATCH_FILE" ] || die "没找到 $PATCH_FILE"
ENV_FILE="$DSH_HOME_DIR/.env"
[ -f "$ENV_FILE" ] && chmod 600 "$ENV_FILE"

env_names="$(grep -oE 'process\.env\.[A-Z][A-Z0-9]*_[A-Z0-9_]*' "$PATCH_FILE" | sed 's/process\.env\.//' | awk '!seen[$0]++')"
[ -n "$env_names" ] || die "配置层里没读到任何变量名"


say "收集必填配置（写进 $ENV_FILE，600，不进 git）"
if [ ! -s "$ENV_FILE" ]; then
  printf '# 橘波特自部署配置（deploy.sh 生成；dsh 启动时会自动加载本文件）\n' >> "$ENV_FILE"
fi
for name in $env_names; do
  case "$name" in
    *_DATA|*_WORKSPACE) continue ;;   # 有默认值，不打扰
  esac
  if grep -q "^${name}=" "$ENV_FILE" 2>/dev/null; then
    say "已有 $name，保留不动"
    continue
  fi
  case "$name" in
    *CROSSGRAM*ENDPOINT)
      # 只接官方 bot：这条路不接，填个死地址，插件会一直重连告警但无害
      value="http://127.0.0.1:9/satori"
      ;;
    *CROSSGRAM*)
      value="placeholder"
      ;;
    *BASE_URL) value="$(ask "$name" "${ARG_LLM_URL:-https://api.deepseek.com/v1}")" ;;
    *ENDPOINT)
      if [ "${name#*KOISHI}" != "$name" ]; then
        value="$(ask "$name" "http://127.0.0.1:5140/satori")"
      else
        value="http://127.0.0.1:9/satori"
      fi
      ;;
    *TOKEN|*KEY)
      if [ "${name#*KOISHI}" != "$name" ]; then
        value="$(ask "$name" "${ARG_SATORI:-}" secret)"
        need_value "$name" "$value"
      else
        value="placeholder"
      fi
      ;;
    *) value="$(ask "$name" "")" ;;
  esac
  printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  say "写入 $name"
done
chmod 600 "$ENV_FILE"

# ---------- 7. koishi 侧 ----------
KOISHI_FRAGMENT="$DSH_HOME_DIR/koishi-plugins.yml"
if [ "$SKIP_KOISHI" = "1" ]; then
  warn "跳过 AppID/Secret/Token；之后自己照 scripts/README.md 填 koishi.yml"
else
  app_id="$(ask QQ_APP_ID "${ARG_APP_ID:-}")"
  app_secret="$(ask QQ_APP_SECRET "${ARG_APP_SECRET:-}" secret)"
  bot_token="$(ask QQ_BOT_TOKEN "${ARG_BOT_TOK:-}" secret)"
  satori_token="$(grep -E '_KOISHI_[A-Z_]*TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  need_value QQ_APP_ID "$app_id"
  need_value QQ_APP_SECRET "$app_secret"
  need_value QQ_BOT_TOKEN "$bot_token"
  umask 077
  cat > "$KOISHI_FRAGMENT" <<EOF
# 把下面这段并进 koishi 的配置（koishi.yml 的 plugins: 下），端口要和 profile 里的
# koishi endpoint 对上；orange-bridge 的 token 必须和 $ENV_FILE 里那个一致。
port: 5140
plugins:
  adapter-qq:
    id: $app_id
    secret: $app_secret
    token: $bot_token
    type: private
    protocol: websocket
    sandbox: true
  server-satori:
    path: /satori
    token: $satori_token
  orange-bridge:
    path: /satori/orange
    token: $satori_token
EOF
  chmod 600 "$KOISHI_FRAGMENT"
  say "koishi 插件片段写到 $KOISHI_FRAGMENT（含密钥，600）"
fi

# ---------- 8. 收尾 ----------
cat <<EOF

==> 装好了。剩下的按顺序：

  1. 去 q.qq.com 建机器人 → 应用管理 → 机器人，拿 AppID / AppSecret / Token
     （要改凭据就删掉 $ENV_FILE 里对应那行再跑一次本脚本）
  2. koishi：把 $KOISHI_FRAGMENT 的内容并进 koishi 配置，然后启动 koishi
  3. 群主或群管理员把机器人拉进测试群（沙箱阶段只在自己群能测）
  4. 起 dsh：  dsh web
     日志里会打印带 token 的面板地址，侧栏出现「🍊 Orange Bot」
  5. 面板里把 admins 填成 qq:<你的 openid>，把测试群加白名单，先开 dry run
  6. 群里 @它 说一句，去面板「响应记录」看它这次为什么醒

  这台机器不需要公网 IP：koishi 往 q.qq.com 连，dsh 往 koishi 连，都是出站。
EOF
