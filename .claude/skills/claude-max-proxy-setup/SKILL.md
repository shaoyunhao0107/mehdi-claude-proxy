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
客户端本地执行工具 → 下一次请求带 tool_result → 代理把整段历史拼成文本再跑 1 轮
```

- 封号风险低：只走官方 SDK/CLI，不提取、不转发 OAuth 令牌，不伪装请求。
- 认证：**复用机器上现有的 `claude` 登录**（`~/.claude/.credentials.json`），不需要 `claude setup-token`，也不要设 `CLAUDE_CODE_OAUTH_TOKEN`。
- 代价：每轮 6–15 秒（每轮重启 SDK）；历史每轮重发、无提示缓存，更费额度；无深度思考；图片只以文字占位。

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

## 本地补丁（相对上游，升级时要保留）

1. `package.json`：`@anthropic-ai/claude-agent-sdk` 升到 0.3.x。上游锁的 0.1.x 自带的 CLI 是 2.0.77，新模型（如 Opus 5.5）会报 `claude_code_version_too_old`。SDK 版本最好和本机 `claude --version` 对齐（CLI 2.1.N ↔ SDK 0.3.N）。
2. `src/services/sdkBridge.ts`：0.3 的 `interrupt()` 返回值类型变了，包了一层 `async () => { await ... }`。
3. `src/routes/anthropic.ts`：
   - 请求里的 `thinking` 字段直接忽略。上游会返回 400，而 Claude Code 每个请求都带这个字段。
   - 允许 `role: "system"` 的消息。新版 Claude Code 会在对话中间插入 system 消息，编码成 `[System]: ...`。
   - 允许历史里出现 `thinking` / `redacted_thinking` 块（会被丢掉）。
   - 新版 SDK 跑到 maxTurns 上限时会抛 `error_max_turns` 异常。如果已经截获到 tool_use，就忽略这个异常，否则会变成 500。
   - SDK 的 `cwd` 指向空目录 `data/sdk-cwd`（可以用 `SDK_CWD` 环境变量覆盖），防止模型看到代理自己的路径、跑去那里找文件。
4. `src/middleware/adminAuth.ts`：管理接口只允许 127.0.0.1 / ::1 访问。
5. 新增 `scripts/install-windows.ps1`、`scripts/start-public.ps1` 和本 skill。

## 同步上游更新

```bash
git remote add upstream https://github.com/MehdiMohseni82/claude-code-proxy.git   # 只需一次
git fetch upstream && git merge upstream/main     # 冲突时以保留上面的本地补丁为准
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
| 抓客户端原始请求 | 在本机起一个转发代理，把请求体 dump 下来再转给 3457，用来对比 Claude Code 发了哪些新字段 |

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
