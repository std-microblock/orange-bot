# dsh-plugin-orange-voice

橘波特的"耳朵和嘴"：家里一台刷了 [open-xiaoai](https://github.com/idootop/open-xiaoai) 补丁固件的小爱音箱（OH2P/LX06），把麦克风流推给 VM，VM 自己做 VAD 和唤醒判断，用 **DeepSeek 语音识别**转写，交给一个托管在 dsh-im 上的语音会话；回答用 **DeepSeek 语音合成**，PCM 流推回音箱播放。

音箱上的 client **不需要改**：用的全是 stock Rust client 已有的能力（`start_recording` 录音流、`start_play` + `play` 播放流、`kws`/`instruction`/`playing` 事件、`run_shell`）。

## 链路

```
小爱音箱（open-xiaoai client，主动连 ws://<vm>:4399）
  │ start_recording → Stream{tag:"record"}  16 kHz / 16-bit / mono，30 ms 一包
  │ Event kws {"Keyword":"…"}                 自定义唤醒词（音箱上的 sherpa-onnx，可选）
  │ Event instruction {"NewLine":"…"}         小爱自己的识别器（"小爱同学"唤醒、它的识别结果）
  ▼
SpeakerLink（ws 服务端，allowFrom / token）
  ▼
Vad（自适应能量阈值：底噪 × ratio，起始 90 ms，静音 700 ms 收尾，带 300 ms 预录）
  ▼  一句话（utterance）
WakeGate：唤醒窗口？ ──否──▶ 丢弃（alwaysListen 时先转写，没有称呼前缀也丢弃，不记录）
  │是
  ▼
DeepSeek ASR  POST {baseUrl}/v1/tools/asr  multipart file=speech.wav
  ▼  去掉句首称呼/唤醒词；只剩唤醒词 → 窗口还给下一句
ctx.im.sessions.deliver('orange-voice:main', steer, <voice from="主人（音箱）" time="14:07" via="kws">…</voice>)
  ▼
语音会话（owner orange-voice，绑定主人私聊为 home）── speak ──▶ DeepSeek TTS  POST /v1/tools/tts {format:"pcm"}
                                                        24 kHz PCM 边收边推：start_play(24k) → Stream{tag:"play"} … → stop_play
```

### 唤醒

| 来源 | 怎么判断 | 配置 |
|---|---|---|
| 自定义唤醒词 | client 的 `kws` 事件（音箱上装了 kws 模型才有） | `wake.kws`、`wake.wakeWords` |
| 小爱原生唤醒 | 小爱识别器开始出中间结果（`SpeechRecognizer/RecognizeResult`，`is_final:false`）即开窗；等它的最终结果（`nativeWaitMs`），以 `bypassPrefixes`（默认「小爱」）开头的句子留给小爱自己（"小爱同学，小爱开灯"），其余的用**我们自己录的音**送 DeepSeek ASR | `wake.native`、`wake.bypassPrefixes` |
| 追问 | 橘波特刚 `speak` 完 `followUpMs` 内的下一句不用再唤醒 | `wake.followUpMs` |
| 句首称呼 | `alwaysListen: true` 时每句都转写，只收以 `prefixes`（「橘波特」「让橘波特」…）开头的 | `wake.alwaysListen`、`wake.prefixes` |

一个窗口只服务一句话。被采纳的那句默认会打断小爱自己的回答（`takeover`：重启 `mico_aivs_lab`，就是上游的 `abort_xiaoai`）。

播放期间（我们在推音频，或者小爱自己 `playing`）VAD 静音，播完再多等 400 ms，免得把自己的声音转写成主人的话。

### 播放的节流

client 的播放器对每次写 aplay 管道只等 100 ms，写不进去就丢包；所以 PCM 按 100 ms 一块推，最多领先实时 `playLeadMs`（400 ms）。TTS 的响应体是流式的，第一块到了就开始播。DeepSeek TTS 失败时（网络、内容审核 400…）默认回退到音箱自带的 `tts_play.sh`（`ttsFallback`）。

## 会话接入（为什么不走主人私聊的 dispatch 路由）

语音不是平台消息：没有平台 message id，不能引用、不能被动回复（v1 里正是把语音伪装成 QQ 私聊消息，才踩了"不存在的 msg_id 当被动回复锚点"的坑），dsh-im 的 `im/message` 入站链也只收适配器的事件。路由 session 又是只读、限步数、只用 `router_reply` 发文字的。所以语音作为 dsh-im **之外**的一个来源，插件用公开的 `ctx.im.sessions` 托管一个自己的会话：

- key `orange-voice:main`、owner `orange-voice`，组合（preset/provider/model/cwd）来自 `session.composition`；
- `session.chat` 配了主人私聊的 chat key 时，绑定为可写 home：语音会话能用 `im_send` 把长内容发到私聊，`task_start`（把 `orange-voice` 加进 dsh-im-session-tasks 的 `owners`）开出的后台任务也落在私聊里；
- 每句采纳的转写是一次持久化 `deliver`（`id = voice:<时间>-<序号>`，steer），重启不会重复投递；
- 橘波特的人设（dsh-plugin-orange 的 `orange:persona`，角色 `voice`）照样渲染，同一份记忆、项目和权限；本插件再加一段 `orange-voice:speak` 说明 `speak` 的用法。

## 工具

| 工具 | 谁能用 | |
|---|---|---|
| `speak { text, interrupt? }` | 语音会话、它开的任务和子 agent、绑定了主人私聊的会话 | 念一句；去掉 markdown/链接/占位符，最多 `maxSpeakChars` 字 |
| `speaker_status { probe? }` | 同上 | 在线情况、最近听到的（含为什么没接）、最近念的 |
| `speaker_recover` | 同上 | 连接还在但再也听不到东西时，重启音箱上的 client（需要 `advertise`） |

面板（dsh-im-panel 装了时）多一个「小爱音箱」页签：状态、最近听到的、测试念一句、打断、重启 client。

## 配置

| 字段 | 默认 | |
|---|---|---|
| `enabled` | `false` | 不开就不监听 |
| `host` / `port` | `0.0.0.0` / `4399` | 音箱 `server.txt` 里写的地址 |
| `allowFrom` | `[]` | 来源 IP（精确或以 `.` 结尾的前缀）。**协议没有鉴权，`run_shell` 在音箱上是 root**，务必填音箱的 IP |
| `token` | `''` | 可选（`?token=` 或路径）；stock client 不带 |
| `session.key` / `composition` / `chat` / `speaker` | `orange-voice:main` / 必填 / — / `主人（音箱）` | 语音会话 |
| `deepseek.baseUrl` / `apiKey` / `voice` | `https://api.deepseek.com` / `''` / `stella` | 部署里用宿主机 relay：`baseUrl` 指向 relay，VM 上不放真 key |
| `tts` / `ttsFallback` | `deepseek` / `true` | `native` = 只用 `tts_play.sh` |
| `wake.*` | 见上表 | |
| `vad.*` | `minRms 350, ratio 3, startMs 90, silenceMs 700, minSpeechMs 400, maxUtteranceMs 30000, preRollMs 300` | ASR 单次上限 120 s / 8 MiB |
| `takeover` | `true` | 采纳时打断小爱 |
| `maxSpeakChars` / `playLeadMs` | `300` / `400` | |
| `advertise` | `''` | `speaker_recover` 用的 `ws://…` |

## 隐私

- 默认关；开了以后只有唤醒窗口内（或带称呼前缀）的句子会被转写并进入会话。`alwaysListen` 会把房间里的每句话都送去 ASR（不带前缀的转写结果立刻丢弃、不落盘、不进面板），按需开。
- 音频本身不落盘；面板只保留最近 50 条判定记录（在内存里）。
- 别的会话（群里）调不了 `speak`：语音是主人的房间，不是群里谁都能喊的喇叭。

## 如果将来要改 client

现在的方案靠 stock client 就够。真要改，值得做的只有两件，协议都能向后兼容：

1. 录音流改成真正的二进制帧（现在 `Stream.bytes` 是 JSON 数字数组，约 4 倍体积；局域网里 16 kHz 单声道无所谓）；
2. 播放端的 100 ms 写超时改成背压，服务端就不用按实时节流。

## 开发

`pnpm --filter dsh-plugin-orange-voice run typecheck | test | build`。测试里有一个假音箱（按 Rust client 的方式应答 RPC、推录音流、收播放流）和一个假的 DeepSeek ASR/TTS 服务，覆盖：唤醒 → 录音 → VAD → ASR → 投递、TTS 流式播放与节流、追问窗口、来源白名单、TTS 失败回退 `tts_play.sh` 与 shell 引号。
