<#
.SYNOPSIS
  橘波特（orange-bot）自部署脚本 —— Windows 版，只接 QQ 官方 bot（koishi）这一条线。

.DESCRIPTION
  做四件事：装 dsh、克隆/更新 orange-bot 并构建插件、把插件挂进 profile、
  把必填配置问出来写进 $DSH_HOME\.env（不进 git）。
  不 sudo、不装系统包、不改你已有的配置、不打印任何密钥。

  执行策略拦住了就先开一个窗口跑：
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  然后：
    .\deploy.ps1 --go

.PARAMETER Go
  交互模式，一步步问你（密钥输入不回显）。
.PARAMETER Yes
  无人值守；必须同时给全 --llm-base-url / --llm-key / --satori-token 等参数。
#>
[CmdletBinding()]
param(
  [switch]$Go,
  [switch]$Yes,
  [string]$Dir = (Join-Path $HOME 'orange-bot'),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [string]$LlmBaseUrl = '',
  [string]$LlmKey = '',
  [string]$SatoriToken = '',
  [string]$AppId = '',
  [string]$AppSecret = '',
  [string]$BotToken = '',
  [switch]$SkipKoishi,
  [string]$Source = '',
  [switch]$NoClone,
  [string]$Container = '',
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$RepoUrl = if ($env:ORANGE_REPO_URL) { $env:ORANGE_REPO_URL } else { 'https://github.com/std-microblock/orange-bot' }
$PluginName = 'dsh-plugin-orange'
$Profile = 'web'

function Say([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Die([string]$msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

function Show-Usage {
  @'
橘波特自部署脚本（Windows，只接 QQ 官方 bot）

  .\deploy.ps1              打印本用法，什么都不做
  .\deploy.ps1 -Go          交互式一步步来（推荐第一次用）
  .\deploy.ps1 -Yes ...     无人值守，缺的必填项用参数给，缺一个就报 MISSING_CREDENTIAL

参数
  -Go                    交互模式：每步会问你，密钥输入不回显
  -Yes                   无人值守；必须同时给下面的必填参数
  -Dir <路径>            orange-bot 检出目录（默认 ~\orange-bot）
  -DshHome <路径>        dsh 的家目录（默认 $env:DSH_HOME 或 ~\.dsh）
  -LlmBaseUrl <url>      OpenAI 兼容端点，例如 https://api.deepseek.com/v1
  -LlmKey <key>          该端点的 key
  -SatoriToken <串>      koishi 侧 Satori 服务的 token（自己编，两边一致）
  -AppId <id>            q.qq.com 机器人 AppID
  -AppSecret <secret>    机器人 AppSecret
  -BotToken <token>      机器人 Token
  -SkipKoishi            不问 AppID/Secret/Token
  -Source <路径>         不从 GitHub clone：用本地目录或 .zip / .tar.gz / .tgz / .tar 装
  -NoClone               同 -Source 一起用：明确表示完全不碰网络（缺 -Source 就报错）
  -Container <ID|名>     不新建容器：在已有的 Docker 容器里装 koishi + adapter-qq + 橘波特的桥
                         （不 stop/rm 容器；写配置前先备份；重复跑不会重复装）

做完的下一步（脚本最后也会再打一遍）：
  1. 去 q.qq.com 建机器人拿 AppID / AppSecret / Token
  2. 把脚本生成的 koishi 插件片段贴进 koishi 的配置并启动 koishi
  3. 群主/管理员把机器人拉进群
  4. 群里 @它 说一句，面板「响应记录」里看它为什么醒
'@
}

if ($Help -or (-not $Go -and -not $Yes)) { Show-Usage; exit 0 }

function Read-Plain([string]$prompt, [string]$default) {
  if ($default) { $v = Read-Host "$prompt [$default]" } else { $v = Read-Host $prompt }
  if ([string]::IsNullOrEmpty($v)) { return $default }
  return $v
}

function Read-Secret([string]$prompt, [string]$default) {
  if ($Yes) { return $default }
  $secure = Read-Host $prompt -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if ([string]::IsNullOrEmpty($plain)) { return $default }
  return $plain
}

function Need([string]$label, [string]$value) {
  if ([string]::IsNullOrEmpty($value)) {
    Die "MISSING_CREDENTIAL: 缺 $label（-Yes 模式必须用参数给全，或者先跑 -Go 交互一遍）"
  }
  return $value
}

function Write-Utf8NoBom([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

# ---------- 1. Node ----------
Say '检查 Node（要 ^22.19 或 >=24）'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die '没找到 node。装 Node 24 LTS（https://nodejs.org/ 的 Windows 安装包），装完重开一个 PowerShell 再跑本脚本。'
}
$nodeVersion = (& node -v).TrimStart('v')
$ok = & node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a===22&&b>=19)||a>=24 ? "1":"0"'
if ($ok -ne '1') { Die "Node v$nodeVersion 太老：要 ^22.19 或 >=24（插件用 node:sqlite）" }
Say "Node v$nodeVersion OK"

# ---------- 2. dsh ----------
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  Say '安装 @deepseek-ai/dsh'
  & npm install -g '@deepseek-ai/dsh'
  if ($LASTEXITCODE -ne 0) { Die '全局安装失败；检查 npm 前缀权限（npm config get prefix）' }
  $env:Path = "$env:Path;$env:APPDATA\npm"
}
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  Die '装完还是找不到 dsh：把 %APPDATA%\npm 加进 PATH 后重开一个窗口'
}
Say 'dsh 已就绪'

# ---------- 3. clone / 更新 ----------
function Assert-SafeListing([string]$archive) {
  $entries = @()
  if ($archive -match '\.zip$') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
    try { $entries = @($zip.Entries | ForEach-Object { $_.FullName }) } finally { $zip.Dispose() }
  } else {
    $entries = @(& tar -tzf $archive)
    if ($LASTEXITCODE -ne 0) { Die "读不了压缩包清单：$archive" }
  }
  foreach ($e in $entries) {
    if ($e -match '^/' -or $e -match '(^|[\\/])\.\.([\\/]|$)') {
      Die "压缩包里有绝对路径或 .. 条目，拒绝解压：$archive"
    }
  }
}

function Install-FromSource([string]$src) {
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('orange-src-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    if (Test-Path -PathType Container $src) {
      Say "从本地目录取代码：$src"
      Copy-Item -Recurse -Force (Join-Path $src '*') $tmp
    } elseif (Test-Path -PathType Leaf $src) {
      if ($src -notmatch '\.(zip|tar\.gz|tgz|tar)$') { Die "-Source 只认目录、.zip、.tar.gz/.tgz/.tar：$src" }
      Assert-SafeListing $src
      Say "解压：$src"
      if ($src -match '\.zip$') {
        Expand-Archive -Path $src -DestinationPath $tmp -Force
      } else {
        & tar -xzf $src -C $tmp
        if ($LASTEXITCODE -ne 0) { Die '解压失败' }
      }
    } else {
      Die "找不到 -Source：$src"
    }

    $root = $tmp
    $kids = @(Get-ChildItem -Force $tmp)
    if ($kids.Count -eq 1 -and $kids[0].PSIsContainer) { $root = $kids[0].FullName }
    if (-not (Test-Path (Join-Path $root "packages\$PluginName\package.json"))) {
      Die "这份源码里没有 packages\$PluginName，路径不对？"
    }
    if ((Test-Path $Dir) -and @(Get-ChildItem -Force $Dir).Count -gt 0) {
      Die "$Dir 已存在且非空；离线安装请换 -Dir <新目录>（脚本不会覆盖已有目录）"
    }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Copy-Item -Recurse -Force (Join-Path $root '*') $Dir
    Say "已就位：$Dir（离线模式，没有 .git）"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

if ($Source) {
  Install-FromSource $Source
  Warn '离线模式：以后更新就再下一份压缩包，解到新目录后用 -Dir 指过去（没有 git pull 这条路）'
} elseif ($NoClone) {
  Die '-NoClone 要和 -Source <目录或压缩包> 一起用'
} elseif (Test-Path (Join-Path $Dir '.git')) {
  Say "更新 $Dir"
  & git -C $Dir fetch --depth 1 origin main
  & git -C $Dir merge --ff-only FETCH_HEAD | Out-Null
} else {
  Say "克隆 orange-bot 到 $Dir"
  & git clone --depth 1 $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { Die 'git clone 失败；先装 Git for Windows 并确认 git 在 PATH 里' }
}
$PluginDir = Join-Path (Join-Path $Dir 'packages') $PluginName
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) { Die "没找到 $PluginDir\package.json，仓库结构变了？" }


# ---------- 容器模式：装进已有容器（不碰容器生命周期）----------
function Install-IntoContainer([string]$cid) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die '没找到 docker 命令。-Container 要在装了 Docker CLI 的宿主机上用；没有 Docker 就走 bare 模式（不加 -Container）'
  }
  & docker inspect $cid 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "docker inspect 找不到容器：$cid（docker ps 看一眼名字/ID）" }

  $image = (& docker inspect -f '{{.Config.Image}}' $cid) -join ''
  $user = (& docker inspect -f '{{.Config.User}}' $cid) -join ''
  Say "容器 $cid：镜像 $image，运行用户 $(if ($user) { $user } else { 'root(默认)' })"

  & docker exec $cid sh -lc 'command -v node >/dev/null 2>&1'
  if ($LASTEXITCODE -ne 0) {
    Die '容器里没有 node。换 node:24-bookworm 这类带 Node 的镜像重建容器，或改用 bare 模式：不加 -Container'
  }
  $nodev = (& docker exec $cid sh -lc 'node -v') -join ''
  Say "容器内 Node：$nodev"

  & docker exec $cid sh -lc 'command -v koishi >/dev/null 2>&1'
  if ($LASTEXITCODE -eq 0) {
    Say '容器里已经有 koishi，跳过全局安装'
  } else {
    Say '在容器里装 koishi + adapter-qq + server-satori（npm i -g，可能要几分钟）'
    & docker exec $cid sh -lc 'npm i -g koishi @satorijs/adapter-qq @koishijs/plugin-server-satori'
    if ($LASTEXITCODE -ne 0) { Die "容器内 npm 安装失败。可以先进去看：docker exec -it $cid sh" }
  }

  $bridge = Join-Path (Join-Path $Dir 'packages') 'koishi-plugin-orange-bridge'
  if (-not (Test-Path $bridge)) { Die "宿主机上没找到 $bridge（先让本脚本把源码准备好）" }
  & docker exec $cid sh -lc 'mkdir -p /opt/orange'
  & docker cp $bridge "${cid}:/opt/orange/koishi-plugin-orange-bridge" | Out-Null
  Say '桥插件已拷进容器：/opt/orange/koishi-plugin-orange-bridge'

  $cfg = '/opt/orange/koishi.yml'
  & docker exec $cid sh -lc "test -f $cfg"
  if ($LASTEXITCODE -eq 0) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    & docker exec $cid sh -lc "cp -a $cfg $cfg.bak.$stamp"
    Warn "容器里已有 $cfg，已备份成 $cfg.bak.$stamp（原文件没被改）"
  }

  $id = if ($Yes) { $AppId } else { Read-Plain 'QQ_APP_ID' $AppId }
  $sec = if ($Yes) { $AppSecret } else { Read-Secret 'QQ_APP_SECRET' $AppSecret }
  $tok = if ($Yes) { $BotToken } else { Read-Secret 'QQ_BOT_TOKEN' $BotToken }
  $satori = if ($Yes) { $SatoriToken } else { Read-Secret 'KOISHI_SATORI_TOKEN' $SatoriToken }
  $id = Need 'QQ_APP_ID' $id
  $sec = Need 'QQ_APP_SECRET' $sec
  $tok = Need 'QQ_BOT_TOKEN' $tok
  $satori = Need 'KOISHI_SATORI_TOKEN' $satori

  $cfgText = @"
# 由 orange-bot/scripts/deploy.ps1 -Container 生成；密钥在这里，别提交进 git
port: 5140
plugins:
  adapter-qq:
    id: $id
    secret: $sec
    token: $tok
    type: private
    protocol: websocket
    sandbox: true
  server-satori:
    path: /satori
    token: $satori
  orange-bridge:
    path: /satori/orange
    token: $satori
"@
  $tmpCfg = Join-Path ([System.IO.Path]::GetTempPath()) ('koishi-' + [guid]::NewGuid().ToString('N') + '.yml')
  Write-Utf8NoBom $tmpCfg $cfgText
  & docker cp $tmpCfg "${cid}:$cfg" | Out-Null
  Remove-Item -Force $tmpCfg -ErrorAction SilentlyContinue
  & docker exec $cid sh -lc "chmod 600 $cfg" | Out-Null
  Say "配置写进容器：$cfg"

  $mounts = (& docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"`n"}}{{end}}' $cid) -join ''
  if ($mounts) { Write-Host "   容器现有挂载：`n$($mounts -replace '(?m)^', '   ')" }
  if ($mounts -notmatch '/koishi|/opt/orange') {
    Warn '这个容器看起来没把 koishi 的数据目录挂出来：重启容器配置就丢。建议重建时加 -v 到 /koishi（或者 docker cp 出来备份）'
  }

  Write-Host @"

==> 容器模式装完了。剩下的：

  1. 起 koishi（在容器里）：docker exec -it $cid sh -lc 'cd /opt/orange && koishi start'
  2. 宿主机上跑橘波特本体：不加 -Container 再跑一次本脚本（bare 模式），
     koishi 地址填 http://127.0.0.1:5140/satori，token 用刚才那串
  3. 群授权、拿 AppID 这些还是得在 q.qq.com 上做，脚本帮不了

  注意：脚本没有 stop / rm 任何容器；已有的 koishi 配置只备份不改。
"@
}

if ($Container) {
  Install-IntoContainer $Container
  exit 0
}

# ---------- 4. 装依赖并构建 ----------
Say '安装插件依赖并构建（npm install 会顺手跑一次 build）'
Push-Location $PluginDir
try {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die 'npm install 失败，看上面的报错' }
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $PluginDir 'lib/index.js'))) { Die '构建没产出 lib\index.js' }

# ---------- 5. 挂进 profile ----------
Say "准备 dsh profile：$DshHome\profiles\$Profile"
$env:DSH_HOME = $DshHome
& dsh --profile $Profile --dump-config | Out-Null
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$ProfilePkg = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $ProfilePkg)) { Die "profile 没生成：$ProfilePkg 不存在" }

$pkg = Get-Content -Raw $ProfilePkg | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$link = 'link:' + ($PluginDir -replace '\\', '/')
$pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $link -Force
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
if ($bundles -notcontains $PluginName) { $bundles += $PluginName }
$pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
if (-not $pkg.dsh.profile.patchReload) {
  $pkg.dsh.profile | Add-Member -NotePropertyName patchReload -NotePropertyValue 'live' -Force
}
Write-Utf8NoBom $ProfilePkg ($pkg | ConvertTo-Json -Depth 20)
Say "profile 已挂上 $PluginName"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Say '没有 pnpm，试 corepack 开一下'
  & corepack enable 2>$null
  if ($LASTEXITCODE -ne 0 -or -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    & npm install -g pnpm
  }
}
Push-Location $ProfileDir
try { & pnpm install --silent } finally { Pop-Location }

# ---------- 6. 必填配置 ----------
$PatchFile = Join-Path $PluginDir 'cordis.patch.yml'
if (-not (Test-Path $PatchFile)) { Die "没找到 $PatchFile" }
$EnvFile = Join-Path $DshHome '.env'

# 变量名不写死：从插件自带的配置层里读，插件改名脚本也跟着走。
$matches = [regex]::Matches((Get-Content -Raw $PatchFile), 'process\.env\.([A-Z][A-Z0-9]*_[A-Z0-9_]*)')
$envNames = @()
foreach ($m in $matches) { if ($envNames -notcontains $m.Groups[1].Value) { $envNames += $m.Groups[1].Value } }
if ($envNames.Count -eq 0) { Die '配置层里没读到任何变量名' }

$existing = @{}
if (Test-Path $EnvFile) {
  foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=') { $existing[$Matches[1]] = $line }
  }
}

$lines = New-Object System.Collections.Generic.List[string]
if (-not (Test-Path $EnvFile) -or (Get-Item $EnvFile).Length -eq 0) {
  $lines.Add('# 橘波特自部署配置（deploy.ps1 生成；dsh 启动时会自动加载本文件）')
}
Say "收集必填配置（写进 $EnvFile，不进 git）"
foreach ($name in $envNames) {
  if ($name -match '_(DATA|WORKSPACE)$') { continue }
  if ($existing.ContainsKey($name)) { Say "已有 $name，保留不动"; $lines.Add($existing[$name]); continue }

  $value = ''
  if ($name -like '*CROSSGRAM*ENDPOINT') {
    $value = 'http://127.0.0.1:9/satori'          # 只接官方 bot：这条路不接
  } elseif ($name -like '*CROSSGRAM*') {
    $value = 'placeholder'
  } elseif ($name -like '*BASE_URL') {
    $default = if ($LlmBaseUrl) { $LlmBaseUrl } else { 'https://api.deepseek.com/v1' }
    $value = if ($Yes) { $default } else { Read-Plain $name $default }
  } elseif ($name -like '*ENDPOINT') {
    if ($name -like '*KOISHI*') { $value = Read-Plain $name 'http://127.0.0.1:5140/satori' }
    else { $value = 'http://127.0.0.1:9/satori' }
  } elseif ($name -match '_(TOKEN|KEY)$') {
    if ($name -like '*KOISHI*') {
      $default = $SatoriToken
      $value = if ($Yes) { $default } else { Read-Secret $name $default }
      $value = Need $name $value
    } else { $value = 'placeholder' }
  } else {
    $value = if ($Yes) { '' } else { Read-Plain $name '' }
  }
  $lines.Add("$name=$value")
  Say "写入 $name"
}
Write-Utf8NoBom $EnvFile (($lines -join "`n") + "`n")

# ---------- 7. koishi 侧 ----------
$Fragment = Join-Path $DshHome 'koishi-plugins.yml'
if ($SkipKoishi) {
  Warn '跳过 AppID/Secret/Token；之后自己照 scripts/README.md 填 koishi.yml'
} else {
  $id = if ($Yes) { $AppId } else { Read-Plain 'QQ_APP_ID' $AppId }
  $sec = if ($Yes) { $AppSecret } else { Read-Secret 'QQ_APP_SECRET' $AppSecret }
  $tok = if ($Yes) { $BotToken } else { Read-Secret 'QQ_BOT_TOKEN' $BotToken }
  $id = Need 'QQ_APP_ID' $id
  $sec = Need 'QQ_APP_SECRET' $sec
  $tok = Need 'QQ_BOT_TOKEN' $tok
  $satori = ''
  foreach ($name in $envNames) {
    if ($name -like '*KOISHI*' -and $name -match '_(TOKEN|KEY)$') {
      $hit = $lines | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
      if ($hit) { $satori = $hit.Substring($hit.IndexOf('=') + 1) }
    }
  }
  $fragmentText = @"
# 把下面这段并进 koishi 的配置（koishi.yml 的 plugins: 下），端口要和 profile 里的
# koishi endpoint 对上；orange-bridge 的 token 必须和 $EnvFile 里那个一致。
port: 5140
plugins:
  adapter-qq:
    id: $id
    secret: $sec
    token: $tok
    type: private
    protocol: websocket
    sandbox: true
  server-satori:
    path: /satori
    token: $satori
  orange-bridge:
    path: /satori/orange
    token: $satori
"@
  Write-Utf8NoBom $Fragment $fragmentText
  Say "koishi 插件片段写到 $Fragment（含密钥）"
}

# ---------- 8. 收尾 ----------
Write-Host @"

==> 装好了。剩下的按顺序：

  1. 去 q.qq.com 建机器人 → 应用管理 → 机器人，拿 AppID / AppSecret / Token
     （要改值就删掉 $EnvFile 里对应那行再跑一次本脚本）
  2. koishi：把 $Fragment 的内容并进 koishi 配置，然后启动 koishi
  3. 群主或群管理员把机器人拉进测试群（沙箱阶段只在自己群能测）
  4. 起 dsh：  dsh web
     日志里会打印带 token 的面板地址，侧栏出现「🍊 Orange Bot」
  5. 面板里把 admins 填成 qq:<你的 openid>，把测试群加白名单，先开 dry run
  6. 群里 @它 说一句，去面板「响应记录」看它这次为什么醒

  这台机器不需要公网 IP：koishi 往 q.qq.com 连，dsh 往 koishi 连，都是出站。
"@
