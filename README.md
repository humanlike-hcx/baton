# Baton · 个人 agent 工作台

Baton 是接力棒：agent 之间按规则交接，同一时间只有一个 agent 拿着棒改文件。

把你已经在付费的订阅（ChatGPT、Cursor、DeepSeek）接进同一个本地工作台：多个 agent 在**同一个工作区**里接力完成任务，共用一套上下文、记忆、工具和规则。引擎是 [Pi](https://github.com/earendil-works/pi)，Cursor 的模型通过官方 Cursor Agent CLI 的 ACP 模式接入。

第一版是本地网页（单人、单机），结构按以后包成桌面应用设计。要做什么、验收标准和当前进度见 [`docs/spec.md`](docs/spec.md)，实现方式见 [`docs/design.md`](docs/design.md)。

## 接入方式

每个模型家族只有一条接入路线，不重复：

| 运行时 | 账号来源 | 模型 |
|---|---|---|
| Pi | ChatGPT 登录（Sign in with ChatGPT，或 Codex 账号） | GPT 系，只走这一条 |
| Pi | DeepSeek API key（唯一用 key 的例外） | DeepSeek 系 |
| Cursor Agent（ACP） | Cursor 登录（`agent login`） | Cursor 里的非 GPT 模型（Claude、Gemini、Composer…），不提供 Auto |

一个 agent = 角色 + 运行时 + 账号来源 + 具体模型。Cursor 里的每个模型都是独立的 agent，不笼统叫「Cursor」。

## 它做什么

- **线程按阶段接力**：方案 → 实现 → 检查 → 完成，检查可以退回实现。谁来接由规则决定（角色、权限、账号是否可用、额度、成本，检查者避开实现者的模型家族），不是 agent 之间自由传球。
- **硬规则**：检查命令有失败时不能判通过；交接上限、退回上限、连续无进展上限、每线程额度，超了就停下来问你。
- **需要你确认的节点**：方案 → 实现（同时批准写权限）、标记完成、触发规则时。
- **顾问**：一个干净上下文、只读的强模型，第二次退回、问题反复出现或出方案前被请来给建议。
- **共享上下文**：`CONTEXT.md`（房间上下文）、长期记忆（置顶的注入启动上下文，其余按需检索）、教训（反复出现的问题，提醒你固化成规则或检查）、分层规则。
- **启动上下文可见**：每个 agent 开工时收到什么、每段多大、来自哪里、有没有重复，都能在 Agents 页查看；超出预算会拦下，不会悄悄截断。
- **快照与回滚**：每次运行前后用影子 git（`.baton/shadow.git`）快照工作区，可以看 diff、一键回滚。
- **权限**：路径边界和禁止路径、命令白名单/黑名单、执行和联网审批；凭据只存本机，不进浏览器、不进工具环境。

## 本地运行

需要 Node.js ≥ 22.19 和 pnpm 10。

```bash
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:47320>。

- 网页：Vite 开发服务器，`127.0.0.1:47320`
- 本地 API + WebSocket：`127.0.0.1:47321`（只监听本机，校验 Host / Origin，写操作需要 `X-Baton` 请求头）

第一次启动会自动打开演示工作区 `~/.baton/demo-workspace`，里面有离线的演示 agent，不用登录任何账号就能把「方案 → 确认 → 实现（命令审批）→ 检查 → 完成」整条流程走一遍。在新线程的任务里写上「退回」，可以看到检查不通过、退回重做的流程。

### 接入真实账号

在「设置 → 账号」里：

- **ChatGPT**：点「用 ChatGPT 登录」，在浏览器完成授权，会回调到本机 1455 端口。如果工作台跑在别的机器上，把浏览器最后跳转到的 `…:1455/auth/callback…` 链接粘贴回来即可。如果 Sign in with ChatGPT 对你的账号不可用（能登 Codex CLI 却登不上这里），改点「用 Codex 账号登录」，它和 Codex CLI 是同一套登录，同样走 ChatGPT 订阅。
- **Cursor**：先安装 Cursor Agent CLI（`curl https://cursor.com/install -fsS | bash`），再点「登录 Cursor」。没装 CLI 时可以打开「用内置的模拟 Cursor」体验 ACP 流程。
- **DeepSeek**：填 `sk-` 开头的 API key。

然后在「设置 → 工作区」打开你自己的项目目录，在「Agents」里启用或添加 agent。

凭据保存在 `~/.baton/credentials.json`（权限 0600）。服务启动时会删掉环境里的 `OPENAI_API_KEY`，保证 GPT 只走 ChatGPT 登录。

### 环境变量

| 变量 | 作用 |
|---|---|
| `BATON_PORT` | API 端口，默认 `47321` |
| `BATON_WORKSPACE` | 启动时打开的工作区目录 |
| `BATON_HOME` | 工作台自己的数据目录，默认 `~/.baton` |
| `BATON_DEMO=1` | 把打开的工作区当作演示工作区（启用演示 agent） |

### 生产模式

```bash
pnpm build   # 构建网页到 apps/web/dist
pnpm start   # API 服务同时托管网页，打开 http://127.0.0.1:47321
```

### 桌面版（macOS）

```bash
pnpm desktop   # 生成 apps/desktop/out/Baton-darwin-<arch>/Baton.app
```

双击 `Baton.app` 即可使用，服务和界面与网页版是同一套，数据目录同为 `~/.baton`；关掉窗口即退出。桌面版和网页版用同一个端口，不能同时开。应用只做了 ad-hoc 签名，适合在本机自己构建、自己用。

## 给 agent 用的共享工具

Pi 里的 agent 直接调用工作台工具。Cursor agent 通过工作台写进工作区 `.cursor/mcp.json` 的 MCP 服务（`packages/mcp/bin/baton-mcp.mjs`）使用同一套：`read_context`、`memory_search`、`remember`、`write_handoff`。

也可以在终端里用 `baton` 命令（`packages/mcp/bin/baton.mjs`）：

```bash
node packages/mcp/bin/baton.mjs context
node packages/mcp/bin/baton.mjs memory "日期格式"
node packages/mcp/bin/baton.mjs remember "所有日期统一用 ISO 8601"
```

## 目录结构

```
packages/core   引擎：工作区存储、规则与启动上下文、记忆、工具、权限、快照、路由、执行器（Pi / ACP）、编排
packages/mcp    MCP 服务和 baton 命令行，通过本地 API 调用工作台工具
apps/server     本地 HTTP + WebSocket 服务，登录流程、审批、凭据
apps/web        网页界面（React + Vite + Tailwind + shadcn/ui）
docs/design.md  设计文档
```

## 测试

```bash
pnpm test        # 单元测试 + 演示流程端到端 + 模拟 Cursor 的 ACP 测试
pnpm typecheck
```
