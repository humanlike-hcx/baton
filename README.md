# Baton · 多模型对话工作台

把你已经在付费的订阅（ChatGPT、Cursor、DeepSeek）接进同一个本地工作台：打开就是对话框，三个账号下的全部模型都能直接选、随时换着聊；改了文件之后，一键「让另一个模型检查」。每个对话属于一个项目（工作区），左边按项目分组；同一个项目里的模型读写同一批文件，共用一套上下文、记忆、工具和规则，不同项目的对话可以同时在跑。引擎是 [Pi](https://github.com/earendil-works/pi)，Cursor 的模型通过官方 Cursor Agent CLI 的 ACP 模式接入。

单人、单机：本地网页和 macOS 桌面版是同一套。要做什么、验收标准和当前进度见 [`docs/spec.md`](docs/spec.md)，实现方式见 [`docs/design.md`](docs/design.md)。

## 接入方式

每个模型家族只有一条接入路线，不重复：

| 运行时 | 账号来源 | 模型 |
|---|---|---|
| Pi | ChatGPT 登录（Sign in with ChatGPT，或 Codex 账号） | GPT 系，只走这一条 |
| Pi | DeepSeek API key（唯一用 key 的例外） | DeepSeek 系 |
| Cursor Agent（ACP） | Cursor 登录（`agent login`） | Cursor 里的非 GPT、非 DeepSeek 模型（Claude、Gemini、Composer…），不提供 Auto |

不需要建任何配置：登录之后，这个账号下的模型就出现在输入框旁的选择框里。对话和运行记录只记「账号 + 模型」。

## 它做什么

- **打开即对话**：首页就是新对话的输入框，左边是历史对话。随时换模型接着聊，新模型从对话摘要和最近几轮原文接上前面的内容。
- **一个权限开关**：每个对话里选「只读」（默认）、「每次问我」或「允许直接改」，只对这个对话有效，服务重启后回到只读。可写时先快照、同一时间只有一个对话在改文件。
- **让另一个模型检查**：先跑工作区配置的检查命令，再由另一个模型（默认推荐不同家族的）只读地审查这个对话里的改动，结论和问题贴回对话。检查命令有失败时结论不能是通过。
- **共享上下文**：`CONTEXT.md`（房间上下文）、长期记忆（置顶的注入启动上下文，其余按需检索）、教训（反复出现的问题，提醒你固化成规则或检查）、分层规则。
- **启动上下文可见**：每个模型开始回复或检查时收到什么、每段多大、来自哪里、有没有重复，都能在「模型」页查看；超出预算会拦下，不会悄悄截断。
- **快照与回滚**：每次可写的回复前后用影子 git（`.baton/shadow.git`）快照工作区，可以看 diff、一键回滚。
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

第一次启动会自动打开演示工作区 `~/.baton/demo-workspace`，里面有离线的演示模型（「对话」「检查」），不用登录任何账号就能试：把权限切到「允许直接改」，发「写文件：notes/todo.md TODO 补测试」，再点「让另一个模型检查」，会看到检查命令先跑、留着 TODO 的改动被判不通过。

### 接入真实账号

在「模型」页里：

- **ChatGPT**：点「用 ChatGPT 登录」，在浏览器完成授权，会回调到本机 1455 端口。如果工作台跑在别的机器上，把浏览器最后跳转到的 `…:1455/auth/callback…` 链接粘贴回来即可。如果 Sign in with ChatGPT 对你的账号不可用（能登 Codex CLI 却登不上这里），改点「用 Codex 账号登录」，它和 Codex CLI 是同一套登录，同样走 ChatGPT 订阅。
- **Cursor**：先安装 Cursor Agent CLI（`curl https://cursor.com/install -fsS | bash`），再点「登录 Cursor」。没装 CLI 时可以打开「用内置的模拟 Cursor」体验 ACP 流程。
- **DeepSeek**：填 `sk-` 开头的 API key。

然后点左边「项目」旁的文件夹按钮（或「设置 → 项目」）打开你自己的项目目录，它会出现在侧边栏里，点它旁边的加号就在这个项目里开新对话。演示项目留在列表里，不需要时可以在「设置 → 项目」里移除（不删文件）。

凭据保存在 `~/.baton/credentials.json`（权限 0600）。服务启动时会删掉环境里的 `OPENAI_API_KEY`，保证 GPT 只走 ChatGPT 登录。

### 环境变量

| 变量 | 作用 |
|---|---|
| `BATON_PORT` | API 端口，默认 `47321` |
| `BATON_WORKSPACE` | 启动时打开的工作区目录 |
| `BATON_HOME` | 工作台自己的数据目录，默认 `~/.baton` |
| `BATON_DEMO=1` | 把打开的工作区当作演示工作区（出现演示模型） |

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

## 给模型用的共享工具

Pi 里的模型直接调用工作台工具。Cursor 里的模型通过工作台写进工作区 `.cursor/mcp.json` 的 MCP 服务（`packages/mcp/bin/baton-mcp.mjs`）使用同一套：`read_context`、`memory_search`、`remember`、`submit_review`（检查时给出结论）。

也可以在终端里用 `baton` 命令（`packages/mcp/bin/baton.mjs`）：

```bash
node packages/mcp/bin/baton.mjs context
node packages/mcp/bin/baton.mjs memory "日期格式"
node packages/mcp/bin/baton.mjs remember "所有日期统一用 ISO 8601"
```

## 目录结构

```
packages/core   引擎：工作区存储、规则与启动上下文、记忆、工具、权限、快照、线路规则、执行器（Pi / ACP）、对话编排
packages/mcp    MCP 服务和 baton 命令行，通过本地 API 调用工作台工具
apps/server     本地 HTTP + WebSocket 服务，登录流程、审批、凭据
apps/web        网页界面（React + Vite + Tailwind + shadcn/ui）
apps/desktop    Electron 桌面版外壳
docs/spec.md    规格说明：要做什么、验收标准、当前进度
docs/design.md  设计文档
```

## 测试

```bash
pnpm test        # 本地 HTTP API 测试 + 单元测试 + 演示对话端到端 + 模拟 Cursor 的 ACP 测试
pnpm typecheck
```
