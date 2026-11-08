---
name: claude-max-proxy-setup
description: 在一台已登录 Claude Max 的机器上安装、配置、验证、更新或卸载本仓库的 Claude Max 订阅代理（Anthropic /v1/messages 协议，工具在客户端执行），并把其他电脑上的 Claude Code 接到它。触发：部署/安装 Max 代理、把 Max 订阅给家里/另一台电脑的 Claude Code 用、配置 ANTHROPIC_BASE_URL 指向代理、代理报错排查、同步上游更新。
---

# Claude Max 订阅代理：安装与配置

本仓库是 [MehdiMohseni82/claude-code-proxy](https://github.com/MehdiMohseni82/claude-code-proxy) 的私有改版。
它把一台机器上**已登录的 Claude Max 订阅**包装成标准 Anthropic API（`/v1/messages`），
让别的电脑上的 Claude Code 通过 `ANTHROPIC_BASE_URL` 使用，并且**工具（Bash/Read/Edit…）在客户端执行**。

## 原理（排错时要懂）

```
客户端 Claude Code ──/v1/messages(对话+工具清单)──▶ 代理
                                                     │ 把客户端工具注册成空壳 MCP 工具（mcp__proxy__*）
                                                     │ 用官方 Agent SDK 跑 1 轮（maxTurns=1）
                                                     ▼
                                              官方 Claude Code CLI ──▶ Anthropic（走 Max 订阅）
                                                     │ 模型决定调用工具 → 代理截获 tool_use，不执行
客户端 ◀──── stop_reason: tool_use（工具名还原）─────┘
客户端本地执行工具 → 下一次请求带 tool_result → 代理把历史按消息拆成内容块再跑 1 轮
```

主路径在 `src/routes/anthropicNative.ts`（纯聊天和客户端工具都走这里）：
- **历史按消息拆成独立内容块**：上一次请求的内容块正好是这一次的前缀，能命中 Anthropic 的提示缓存。实测 Claude Code 多轮任务中约 77% 的输入是缓存读取。
- **图片 / PDF 原样传**（包括 tool_result 里的图片）。只保留最近 `MAX_HISTORY_IMAGES`（默认 8）张，更早的换成文字占位。
- **真流式**：把上游 Anthropic 的事件流原样转发（工具名还原），非流式请求就从事件流里拼出完整回复。
- **thinking 跟着客户端走**：客户端请求了，就映射成 adaptive 并返回思考摘要；没请求就关掉。注意 CLI 在 5.x 模型上会强制 adaptive，由模型自己决定思考多少。`max_tokens` 和 `output_config.effort` 也会传过去。
- **SDK 隔离运行**：不加载内置工具、本机配置和 skill，不保存会话，不发标题生成、遥测这类附带请求。一次请求只对应一次上游调用，一句"你好"大约 700 tokens。原版一句话就有 1.7 万 tokens，还会把服务器的工具和环境信息带进上下文。
- 请求里带服务端工具（`web_search_2025…` 之类）时，仍走原版的多轮路径（`handleWithTools`），由服务器上的内置工具执行。

### 不带第三方指纹（上游只看到官方的东西）

原则是：不管请求来自哪个客户端，发给 Anthropic 的请求在身份、系统提示、工具定义、消息格式上都和官方 CLI 自己发的一样。

| 项目 | 做法 |
|---|---|
| 请求头、User-Agent、metadata | 一律不转发。上游的身份是官方 Agent SDK：`claude-cli/<ver> (external, sdk-cli, agent-sdk/<ver>)` |
| 系统提示 | `SYSTEM_PROMPT_MODE=official`（默认）：使用 CLI 自带的 Claude Code 预设（`excludeDynamicSections`）。分两种情况：
- 客户端是 Claude Code，系统提示本身就是官方的：**原样使用**，因为里面有客户端的环境信息。之前试过换成服务器的预设，模型会跑去服务器路径找文件，一个任务兜了 67 轮。
- 第三方客户端（比如 Cherry 的助手设定）：上游换成官方预设，第三方的系统提示放进第一条用户消息的 `<system-reminder>`，和官方带 CLAUDE.md 的方式一样。设 `CLIENT_SYSTEM=drop` 则完全不带 |
| 工作目录 | CLI 每个请求**一定会**在最后附带它自己的 `# Environment`（工作目录、系统），没有开关能关掉，模型会以它为准。所以 `MIRROR_CLIENT_CWD`（默认开）会从客户端的环境信息里取出 "Primary working directory"，路径格式和服务器系统一致时（Windows 客户端对 Windows 服务器），就用这个路径作为 SDK 的 cwd，服务器上没有就建一个空目录，两边说法就一致了。格式对不上时（比如 Mac 客户端），退回到在最后一条消息末尾加一段官方格式的 `# Environment update`，写上客户端的环境，效果不如前者稳 |
| 工具定义 | 和 CLI 内置工具同名的（Bash/Read/Edit/Write/Glob/Grep/WebFetch…）启用 CLI **自己的官方定义**；CLI 在这种模式下加载不了的（如 Agent、PowerShell）直接不带，不改名转发。客户端自己的 MCP 工具保持原名 `mcp__<server>__<tool>`；其他名字的工具放在 `mcp__local__`（`BRIDGE_MCP_SERVER` 可改）下面 |
| 工具执行 | PreToolUse 钩子一律拒绝，**任何工具都不在服务器上执行**。工具调用从事件流里截下来交给客户端 |
| 消息格式 | 最后一条是普通用户消息时（每轮聊天、Claude Code 每次新提问），走"原生模式"：用 `sessionStore` + `resume` 把历史交给 CLI，上游看到的是真正的多轮 user/assistant/tool_use/tool_result 消息。最后一条带 tool_result 时（Claude Code 的工具循环），CLI 没法从半路接着跑（恢复时会插入"中断"或 "No response requested." 标记），这时退回"转录模式"：历史拼成按消息分块的文本，说明文字放在 reminder 里，不放在系统提示里。原生模式出错时也自动退回转录模式 |
| 服务器自己的东西 | 自动记忆和组织记忆关闭（`CLAUDE_CODE_DISABLE_AUTO_MEMORY` / `CLAUDE_CODE_DISABLE_ORG_MEMORY`），不加载本机配置和 skill |

剩下没法去掉的：对话内容本身，包括用户写的设定和客户端自定义工具的名字、描述，这些是功能需要的。CLI 自己附加的日期、模型名、账号邮箱提醒也会带上，这些是官方行为。

原生模式的两个副作用（代码里已处理）：
- SDK 恢复会话时会把凭证复制到临时目录 `claude-resume-*`，但**不带 refresh token**，所以这条路径自己不会续期登录令牌。每次原生请求前会检查令牌，剩不到 4.5 分钟就先发一个极小的普通请求让 CLI 续期。临时目录 15 分钟后自动清理。
- `sessionStore` 不能和 `persistSession: false` 一起用，原生模式会把它打开，写入的是 SDK 的临时目录。

其他要点：
- 封号风险低：只走官方 SDK/CLI，不提取、不转发 OAuth 令牌，不伪装请求。上游看到的身份是 `claude-cli/<ver> (external, sdk-cli, agent-sdk/<ver>)`，也就是官方 Agent SDK。客户端（Cherry Studio 等）的请求头**不会转发**到上游。
- 认证：**复用机器上现有的 `claude` 登录**（`~/.claude/.credentials.json`），不需要 `claude setup-token`，也不要设 `CLAUDE_CODE_OAUTH_TOKEN`。
- 剩下的代价：每轮要重新启动一次 SDK，大约多 2 秒开销。Claude Code 一轮连同模型生成总共 6–8 秒。

## 前提条件（服务端）

| 条件 | 检查 |
|---|---|
| Node.js 20+（已在 24 上验证） | `node -v` |
| Claude Code CLI，且已用 Max 账号登录 | `claude --version`；`~/.claude/.credentials.json` 存在 |
| 能访问 api.anthropic.com | 在这台机器上 `claude -p "hi"` 能回复 |
| 一个空闲端口（默认 3457） | `Get-NetTCPConnection -LocalPort 3457`（Windows）/ `ss -ltn`（Linux） |

没装 Claude Code：`npm install -g @anthropic-ai/claude-code`，然后运行 `claude` 登录。登录必须让用户本人在浏览器完成，不要索要或代填账号、令牌。

## 安装：Windows（脚本一键）

在**管理员** PowerShell 中：

```powershell
gh repo clone shaoyunhao0107/mehdi-claude-proxy
cd mehdi-claude-proxy
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Port 3457 -KeyName home-pc
```

脚本会：装依赖并放行 `better-sqlite3` 的本地编译（npm 11+ 默认拦截安装脚本）→ 编译 → 生成 `.admin-secret` →
注册开机计划任务（以当前用户 S4U 身份、无需登录桌面、无运行时长上限、崩溃自动重启）→ 放行 Windows 防火墙端口 →
等服务起来 → 创建客户端 key 写入 `.home-key`。可以重复运行，已有的 secret 和 key 会保留。

装完还要**用户自己**在云服务器安全组/路由器放行该 TCP 端口，最好只放行客户端 IP。

## 安装：Linux / macOS（手动）

```bash
gh repo clone shaoyunhao0107/mehdi-claude-proxy && cd mehdi-claude-proxy
npm install --no-fund --no-audit
npm install-scripts approve better-sqlite3 2>/dev/null; npm rebuild better-sqlite3
node -e "new (require('better-sqlite3'))(':memory:')"   # 必须不报错
npm run build
[ -f .admin-secret ] || node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > .admin-secret
```

Linux 常驻用 systemd（`User=` 必须是已登录 claude 的那个用户）：

```ini
# /etc/systemd/system/claude-max-proxy.service
[Unit]
After=network-online.target
[Service]
User=<登录了 claude 的用户>
WorkingDirectory=/path/to/mehdi-claude-proxy
Environment=PORT=3457
Environment=DATABASE_PATH=/path/to/mehdi-claude-proxy/data/proxy.db
Environment=PATH=/home/<user>/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/sh -c 'ADMIN_API_SECRET=$(cat .admin-secret) exec node dist/server.js'
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now claude-max-proxy`。macOS 用 LaunchAgent，配置项相同。
然后按下面"创建 key"一节建 key。

## 创建 / 吊销客户端 key

管理接口**只允许本机访问**（本地补丁），外网访问返回 404。

```bash
S=$(cat .admin-secret)
curl -s -X POST -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
  http://127.0.0.1:3457/api/admin/keys -d '{"name":"laptop"}'          # 返回里的 key 只显示这一次
curl -s -H "Authorization: Bearer $S" http://127.0.0.1:3457/api/admin/keys   # 列表
curl -s -X DELETE -H "Authorization: Bearer $S" http://127.0.0.1:3457/api/admin/keys/<id>  # 吊销
```

客户端 key 同时支持 `Authorization: Bearer` 和 `x-api-key` 两种请求头。

## 客户端配置（另一台电脑的 Claude Code）

在客户端的 `~/.claude/settings.json` 加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<服务器公网IP>:3457",
    "ANTHROPIC_AUTH_TOKEN": "<.home-key 的内容>"
  }
}
```

- 启动时提示 "claude.ai connectors are disabled" 是正常的：用了自定义地址就不加载 claude.ai 连接器。
- 可以用 `ANTHROPIC_MODEL` 固定模型；没识别的模型名会原样传给上游。
- `/v1/models` 的列表是**自动发现**的（`src/services/modelDiscovery.ts`），新模型出来后会自动加进去：
  1. 用官方 CLI 的 `supportedModels()` 取每个系列的最新版（例如 opus → `claude-opus-5-5`）。这一步只用 CLI 本地的信息，不发对话请求，大约 1 秒。
  2. 以每个最新版为中心探测一批版本号：当前大版本往下所有小版本、往上 2 个小版本、下一个大版本的 x-0、上一个大版本的 0–9。探测是发一句 "hi"：不存在的模型直接报 "may not exist"，不花额度；存在的模型大约花 600 tokens。
  3. 结果缓存在 `data/models.json`，每个 ID 隔 `MODEL_REPROBE_DAYS`（默认 7 天）重新探测一次，用来发现模型下线。每 `MODEL_REFRESH_HOURS`（默认 24 小时）整体刷新一次。第一次完整探测约 3.5 分钟（72 个候选），之后的日常刷新大约 1 秒。
  4. **必须串行探测**：每次探测都是一个 CLI 进程，并行跑在 8 GB 的机器上会内存耗尽（"memory allocation failed"）。
  5. 要另外购买 usage credits 的模型（例如 `claude-fable-5-1`）标记为 `paid`，默认不列出；设 `INCLUDE_PAID_MODELS=true` 可以列出来。
  - 2026-11 的实测结果：opus 5.5 / 4.8 / 4.7 / 4.6 / 4.5 / 4.1 / 4.0，sonnet 5.5 / 4.6 / 4.5，haiku 5.5 / 4.5。
  - 手动刷新和查看（只能本机访问）：`POST /api/admin/models/refresh`（加 `?full=1` 是全部重新探测），`GET /api/admin/models`。
  - 局限：如果出现一个**全新的系列名**（像当初的 fable），而本机 SDK 自带的 CLI 太旧不认识，第 1 步就发现不了它，要升级 SDK（见"同步上游更新"）。同一系列的新版本靠第 2 步的"往上探测"也能发现。
- Cherry Studio 等聊天客户端：选 Anthropic 类型，地址填 `http://<服务器>:3457`，key 同上。思考开关、图片、流式都支持。
- 接口是 HTTP 明文，key 可能被截获。不放心就用 SSH 隧道（`ssh -L 3457:127.0.0.1:3457 user@server`，客户端填 `http://127.0.0.1:3457`），或者在前面加 HTTPS 反代。

## 验证（每次安装或升级后都要跑）

只看能不能聊天不够，必须验证**工具在客户端执行**：

```bash
mkdir /tmp/cc-test && cd /tmp/cc-test && echo "secret-number: 4817" > input.txt
ANTHROPIC_BASE_URL=http://<server>:3457 ANTHROPIC_AUTH_TOKEN=<key> \
  claude -p --permission-mode bypassPermissions \
  "Read input.txt, use Bash to run 'hostname', then write result.txt containing the secret number plus 1 and the hostname. Reply 'done'." < /dev/null
cat result.txt     # 应为 4818 和【客户端】的主机名，文件出现在客户端目录
```

分别用默认模型和 `ANTHROPIC_MODEL=claude-sonnet-4-6` 各跑一次。正常是 30–45 秒左右。
加上 `--output-format json` 可以看 `usage`：多轮任务里 `cache_read_input_tokens` 应该明显大于 `cache_creation_input_tokens`。如果 cache_read 接近 0，说明历史拆块或系统提示不稳定，提示缓存失效了。

## 本地补丁（相对上游，升级时要保留）

1. `package.json`：`@anthropic-ai/claude-agent-sdk` 升到 0.3.x。上游锁的 0.1.x 自带的 CLI 是 2.0.77，新模型（如 Opus 5.5）会报 `claude_code_version_too_old`。SDK 版本最好和本机 `claude --version` 对齐（CLI 2.1.N ↔ SDK 0.3.N）。
2. `src/services/sdkBridge.ts`：
   - 0.3 的 `interrupt()` 返回值类型变了，包了一层 `async () => { await ... }`。
   - 默认 `tools: []`（SDK 默认会加载全套 Claude Code 工具，在服务器上执行，还多 1.7 万 tokens）、`persistSession: false`、环境变量 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 和 `DISABLE_TELEMETRY=1`（去掉标题生成调用和遥测）。
   - 新增 `thinking`、`effort`、`extraEnv` 参数；`prompt` 可以是结构化消息。
3. 新增 `src/routes/anthropicNative.ts`（原理一节里那些优化都在这里）。`src/routes/anthropic.ts` 的路由改成：请求里有服务端工具就走原版 `handleWithTools`，其他全部走 `handleNative`。另外：
   - 不再拒绝 `thinking` 字段（上游原版会返回 400）。**不要在校验阶段把它删掉**，native 处理要读它。
   - 允许 `role: "system"` 的消息。新版 Claude Code 会在对话中间插入 system 消息，编码成 `[System]: ...`。
   - 允许历史里出现 `thinking` / `redacted_thinking` 块（会被丢掉）。
   - 新版 SDK 跑到 maxTurns 上限时会抛 `error_max_turns` 异常。如果已经截获到 tool_use，就忽略这个异常，否则会变成 500。
   - SDK 的 `cwd` 指向空目录 `data/sdk-cwd`（可以用 `SDK_CWD` 环境变量覆盖），防止模型看到代理自己的路径、跑去那里找文件。
4. `src/middleware/adminAuth.ts`：管理接口只允许 127.0.0.1 / ::1 访问。
5. 新增 `src/services/modelDiscovery.ts`，自动发现模型（见客户端配置一节）。`src/routes/proxy.ts` 的 `/v1/models` 改用它，同时带上 OpenAI 和 Anthropic 两种格式的字段。`src/server.ts` 启动时开始发现流程，`src/routes/adminApi.ts` 加了 `/models` 和 `/models/refresh` 两个接口。
6. 新增 `scripts/install-windows.ps1`、`scripts/start-public.ps1` 和本 skill。

## 同步上游更新

```bash
git remote add upstream https://github.com/MehdiMohseni82/claude-code-proxy.git   # 只需一次（新 clone 时）
git fetch upstream && git merge upstream/master    # 冲突时以保留上面的本地补丁为准
npm install && npm run build                       # Windows 记得先重新放行 better-sqlite3
```

升级本机 Claude Code 之后，把 SDK 也对齐：`npm install @anthropic-ai/claude-agent-sdk@0.3.<N>`。
改完重启服务（Windows：`Stop-ScheduledTask` 再 `Start-ScheduledTask`，或者直接结束 node 进程，循环会自动拉起），然后重跑"验证"。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 400 `does not support extended thinking` | 补丁 3 丢了，重新打 |
| 400 `messages[N].role must be 'user' or 'assistant'` | 补丁 3（system 角色）丢了 |
| 500 里带 `claude_code_version_too_old` | SDK 太旧，按补丁 1 升级 |
| 500 里带 `[tool_use: mcp__proxy__...]`，客户端反复重试、一次要几分钟 | 补丁 3 的 maxTurns 异常处理丢了 |
| 401 | key 错了，或请求头没带上 |
| 管理接口 404 | 不是从本机访问的，这是设计如此 |
| 启动后 `better-sqlite3` 报错 | 本地模块没编译：先 `npm install-scripts approve better-sqlite3`，再 `npm rebuild better-sqlite3` |
| 本机能通、外网不通 | 云安全组 / NAT 没放行端口。注意本机有代理 TUN（如 198.18.x）时，查到的"公网 IP"可能是代理的出口 IP |
| Claude Code 任务轮数暴增，模型说"工作目录不一致"、往服务器路径写文件 | 客户端工作目录没对上：检查 `MIRROR_CLIENT_CWD` 有没有被关掉、客户端的系统提示有没有被替换掉（必须原样使用），以及客户端路径格式和服务器是否一致 |
| 一句"你好"就花上万 tokens，或者模型提到服务器上的文件、工具 | 补丁 2 的 `tools: []` 默认值丢了 |
| 客户端开了思考却看不到思考内容 | 补丁 3：`thinking` 在校验阶段被删了，或者没映射成 `adaptive` + `display: summarized`（CLI 会忽略固定预算） |
| 抓客户端原始请求 | 在本机起一个转发代理，把请求体 dump 下来再转给 3457，用来对比 Claude Code 发了哪些新字段 |
| 模型列表缺了某个模型 | 先看 `GET /api/admin/models` 里对应 ID 的 `status`，再 `POST /api/admin/models/refresh?full=1` 重新探测。`error` 状态是临时失败（限流、网络），下次刷新会自动重试 |
| 模型探测报 "memory allocation failed" | 有探测在并行跑，内存不够。确认 `refreshModels` 是串行的；也可能是同时进来的请求太多 |
| 看代理发给 Anthropic 的实际请求 | 另起一个测试实例，设 `ANTHROPIC_BASE_URL=http://127.0.0.1:<录制端口>`，录制程序记下请求（把 authorization 打码）后转发到 `api.anthropic.com` |

日志在 `proxy.log`（Windows 上是 UTF-16 编码，用 `Get-Content` 看）。请求记录在 `data/proxy.db` 的 `request_log` 表。

## 卸载（Windows）

```powershell
Unregister-ScheduledTask mehdi-claude-proxy -Confirm:$false
Get-NetFirewallRule -DisplayName "mehdi-claude-proxy *" | Remove-NetFirewallRule
# 结束监听 3457 的 node 进程后，删除仓库目录即可
```

## 安全

- `.admin-secret`、`.home-key`、`data/` 都在 `.gitignore` 里，**绝不提交**。
- 不要把 key 和令牌贴进聊天或 issue。泄露了就吊销 key，重新创建。
- 一个 Max 订阅只给自己的设备用，不要分享给别人（违反 Anthropic 条款）。
