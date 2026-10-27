# Baton 设计文档

本文档讲怎么实现。要做什么、验收标准和当前进度见 [`spec.md`](spec.md)，两者冲突时以 spec 为准。

个人 agent 工作台：把已订阅的模型登录进来，让多个 agent 在同一个工作区里协作，共用一套上下文、记忆和工具。第一版是单人、单机、本地网页，结构按以后包成 Electron 桌面应用设计。

## 1. 范围

第一版接入三条路径，每个模型家族只走一条：

| 运行时 | 额度来源 | 模型 | 说明 |
|---|---|---|---|
| Pi（我们的循环） | ChatGPT 登录（Sign in with ChatGPT，或与 Codex CLI 相同的 Codex 账号登录） | GPT 系 | GPT 只走这一条 |
| Pi（我们的循环） | DeepSeek API key | DeepSeek 系 | 唯一允许使用 key 的例外 |
| Cursor Agent（通过 ACP） | Cursor 登录（`agent login`） | Cursor 账号可用的非 GPT 模型 | 过滤掉 GPT 家族，不提供 Auto |

ChatGPT 有两种登录方式，都走 ChatGPT 订阅，同一时间只保留一个凭证：

- **Sign in with ChatGPT**：Pi 的 `openai` provider，OpenAI 给第三方 agent 的入口，授权必须带 `chatgpt.tokens.use.direct`，不是每个账号都开放。
- **Codex 账号**：Pi 的 `openai-codex` provider，与 Codex CLI 是同一套 OAuth（同一 client ID、`localhost:1455` 回调），请求发到 `chatgpt.com/backend-api`。Pi 把它标成 legacy，所以只作备选。

GPT agent 卡片里的 provider 始终是 `openai`；运行时 Pi 执行器按已登录的方式选 provider，两者都在时优先 Sign in with ChatGPT。Agents 页的 GPT 模型列表也来自已登录的方式。Codex 账号能用的模型比较少（GPT-5.6 和 GPT-6 系列），卡片上的模型它没有时，运行在发请求之前就失败，并提示换模型。

不做：多人、账号体系、看板、聊天软件集成、容器沙箱、Claude 订阅 token。

## 2. 核心概念

- **工作区**：一个本地目录。所有 agent 读写同一份文件。工作台的状态放在 `<工作区>/.baton/`。
- **agent**：角色 + 运行时 + 模型。定义在 `.baton/agents/*.md` 的 frontmatter（能力卡）。
- **线程**：一件事。按阶段推进：方案 → 实现 → 检查 → 完成，检查可以退回实现。
- **运行**：某个 agent 在某个线程里的一次执行。
- **交接**：每次运行结束时写回的记录：做了什么、改了哪些文件、还剩什么、建议下一步。

## 3. 工作区目录

```
AGENTS.md                 # 公共规则，Pi 和 Cursor 都会读；由工作台维护其中的标记段
.cursor/mcp.json          # 工作台写入 baton MCP 服务
.baton/
  workspace.json          # 工作区设置：检查命令、权限默认值、上限
  CONTEXT.md              # 房间上下文，整理预算默认 6KB，硬上限 8KB
  rules/
    base.md               # 共用底座
    role-plan.md          # 各阶段角色规则
    role-implement.md
    role-review.md
    role-advisor.md
    runtime-pi.md         # 运行时校准
    runtime-cursor.md
    family-<家族>.md      # 可选，默认不启用
  agents/*.md             # 能力卡
  memory/*.md             # 记忆条目（frontmatter 带状态）
  lessons/*.md            # 教训单
  handoffs/<线程>/<运行>.md
  threads/<线程>.json     # 线程与运行元数据
  tidy/<整理>.json        # 房间上下文的整理记录（整理前后原文、移进记忆的条目）
  sessions/               # Pi 会话 JSONL、ACP 事件日志（原始记录，长期保留）
  audit.jsonl             # 工具调用与审批审计
  shadow.git/             # 影子 Git，用于快照、diff、回滚
```

## 4. 上下文

### 4.1 开场注入（按「角色 × 运行时」拼装）

每次运行开始时现场拼装，顺序固定，方便命中提示词缓存：

1. `rules/base.md`
2. `rules/role-<阶段>.md`
3. `rules/runtime-<运行时>.md`
4. 可选的 `rules/family-<家族>.md`
5. agent 自己的职责说明（能力卡正文）
6. `CONTEXT.md`
7. 置顶记忆
8. 线程摘要 + 最近三条交接
9. 自该 agent 上次运行以来的文件 diff 概要
10. 任务卡：阶段、任务、验收标准、角色声明

执行阶段（实现、检查）拿不到调度规则和 `handoff_to`，只能在交接里写「建议下一步」。

**注入预算**：方案/顾问角色 ≤ 24KB，执行角色 ≤ 12KB。超过时运行不会启动，界面提示哪一段超了。每个 agent 都有「开场上下文」页面，列出每段的来源、大小和重复内容。

每次运行记录拼装结果的哈希，原始记录里能还原「当时它看到的是什么」。

### 4.2 压缩

- 运行内：Pi 自带压缩（超过「窗口 − 16k」触发，保留最近约 20k token，结构化摘要）。每次压缩结束（`compaction_end`）时，从摘要里取出「已完成 / 进行中、受阻 / 下一步」存成这次运行的交接草稿（`RunRecord.progress`）。写交接时补上 agent 交接里漏掉的已完成项，「还剩什么」「建议下一步」为空时用草稿填；没写交接时自动生成的交接也带上草稿。Cursor 的压缩由它自己负责。
- 跨运行：agent 之间不传原始对话。线程保留最近三条交接原文，更早的滚进线程摘要。
- `CONTEXT.md` 超预算时，整理员（Pi + DeepSeek）合并重复、把过时细节移进记忆，改动有 diff，可撤销：
  - 预算是设置里的 `budgets.context`（默认 6KB），不能超过 8KB 的硬上限；超过硬上限的写入直接拒绝。
  - 触发：任何一次写 `CONTEXT.md`（界面保存、agent 的 `update_context`）后，超预算就在后台自动整理；上下文页也可以手动「现在整理」。调低预算时也会检查一次。
  - 整理员是一次模型调用（`PiExecutor.complete`，真实工作区用 `deepseek-v4-pro`，演示工作区用脚本化的假模型），输入当前上下文、预算和已有记忆，输出 `{context, memories, summary}` 的 JSON。结果超预算、格式不对、或整理期间上下文又被改过，都放弃这次整理，原文不动。
  - 生效时先把细节逐条写进记忆（照常查重，被拒的记下原因），再写回 `CONTEXT.md`。每次整理存一份记录在 `.baton/tidy/<id>.json`，带整理前后原文，上下文页据此显示 diff。
  - 撤销：只能撤销最近一次生效的整理，而且整理后上下文没再改过；撤销时写回原文，把这次移进记忆的条目标为过时。被撤销或整理失败的那份原文不会再被自动整理，避免来回打转。
  - 没有 DeepSeek key（或关闭了记忆）时不整理，上下文页说明原因。整理的花费记在整理记录里，不计入任何线程的额度。

## 5. 记忆、交接、教训

三条去向：

- 长期不变的约束 → `AGENTS.md` / `rules/`
- 事实和偏好 → `memory/`
- 踩过的坑 → `lessons/`，再设法固化成权限规则、检查命令或测试

记忆条目字段：`id`、`kind`（fact / decision / preference）、`status`（active / superseded）、`supersededBy`、`author`（agent）、`run`、`pinned`、`createdAt`。不删除、不覆盖。写入前检索相近条目。检索用 SQLite 全文索引（或在不可用时退化为内存扫描），不用向量库。工作区可以关闭记忆。

教训单字段：`id`、`title`、`occurrences`、`status`（open / hardened / closed）、`hardenedBy`。同类问题出现第二次时提示固化。关闭条件：「这个坑现在还踩得到吗？」

**维护机制**：

1. 规则写进 `AGENTS.md` 和 `rules/base.md`。
2. 运行结束没调用 `write_handoff`：追加一次 follow-up 要求写；仍然没有，用 DeepSeek 根据记录生成，标记为「自动生成」；DeepSeek 不可用时用最后一条回复生成。
3. 记忆写入校验 schema、长度、重复。

## 6. 接力与路由

agent 只提议目标阶段，harness 决定交给谁。

**挑选顺序**：承担该阶段 → 权限满足 → 额度可用 → 成本从低到高。

**硬性规则**：

- 检查与实现的模型家族不能相同。
- 不能把同一阶段直接交回给刚交过来的 agent；退回只能走「检查 → 实现」。
- 交接需要比发起方更高的权限时，停下来等用户批准。
- 每次交接必须带验收标准；一跳既没改文件、也没新决定算空转，连续两次空转暂停。
- 每个线程自动接力最多 6 跳，退回最多 2 轮；DeepSeek 按人民币设花费上限，ChatGPT 与 Cursor 按次数设上限。
- 同一工作区同时只有一个写运行；只读运行可并行。

**需要用户确认的节点**（每个都可以改成自动）：方案 → 实现之前；标记完成之前；触发任何硬性规则时。

**顾问**：退回到第二轮、检查连续两轮报出新问题、或方案阶段定方向之前，自动请顾问（Pi + GPT，或 Cursor ask 模式的非 GPT 模型）。顾问在只读环境、干净上下文里工作，输入是三栏请教卡：机械事实、我的判断、我希望听到的答案。意见附在审批卡上，由用户决定。

**统计**：按「运行时 + 模型」记录每个阶段的一次通过率、被退回次数、用户采纳率、平均花费。第一版只展示和建议。

**对话线程**（`Thread.kind = "chat"`）：不走接力，阶段固定为 `chat`，角色为 `chat`。

- 用户选 agent，存在 `pinnedAgents.chat`；不按角色挑选，任何启用的 agent 都能聊。每条消息触发一次运行，运行结束回到「空闲」。
- 回复进行中发的消息排队，这一轮结束后接着回复；取消后不自动续上。
- 换 agent 时写一条时间线提示。新 agent 的开场上下文里带「更早的对话（摘要）」和「最近几轮原文」：最近 3 轮原文，更早的每轮压成一行，存在 `thread.summary`，最多 30 行。
- 默认只读。用户开放写权限后（`approvedLevel ≥ 2`），有效权限取 agent 卡片和线程开关的较小者：开关打开且 agent 卡片本身可写时，写文件、命令按 agent 卡片；否则不能写、不能执行命令。可写的对话运行和实现一样占写锁、先快照。服务重启时收回所有对话的写权限。
- 工具：读文件、搜索、读上下文、查和写记忆、记教训，以及权限允许时的改文件和命令；没有 `write_handoff` 和 `handoff_to`。交接由 harness 根据回复自动生成，不进时间线。
- 转成接力线程：`POST /api/threads/:id/promote` 让当前 agent 用一轮普通对话（提示词 `RELAY_DRAFT_PROMPT`）把对话整理成 `{title, task, acceptance}` 的 JSON，结果存在 `thread.promotion`。这一轮走 `chat` 角色，所以 Pi 和 Cursor 两条路线都适用，不需要额外工具。解析不出来、运行失败、被取消或服务重启时，`promotion.status = "failed"`，草稿退回为「用户说过的话」，由用户自己填写。用户核对、修改后调 `.../promote/confirm` 才创建接力线程并开始；接力线程记 `fromChat`，对话记 `relays`，两边互相链接。

## 7. 检查

检查阶段先跑 `workspace.json` 里配置的命令，再交给模型审查。结果四种：通过、失败、跳过、出错，跳过绝不算通过。新增检查命令时，可以提供一个已知有问题的样本，确认它会变红。

## 8. 工具

一份注册表，每个工具登记：名字、描述、参数 schema（TypeBox）、风险等级（read / write / exec / network / memory）、执行函数、暴露范围（native / mcp）、按家族变化的呈现（编辑工具对 GPT 是补丁格式，对其他是文本替换）。

内置工具：`read_file`、`list_files`、`search`、`edit_file`（`apply_patch` 或 `replace`）、`write_file`、`shell`、`read_context`、`update_context`、`memory_search`、`remember`、`write_handoff`、`handoff_to`（仅方案/顾问角色）、`record_lesson`。

出口：

- Pi：作为自定义工具注入，不加载 Pi 的默认资源发现。
- Cursor：本地 MCP 服务 `baton-mcp`，只暴露 4 个工具：`read_context`、`memory_search`、`remember`、`write_handoff`。另有同等功能的 `baton` 命令行。

shell 工具：单独返回退出码；截断时保留开头和结尾，只砍中间，保留 stderr；每个工具有输出上限；时间线显示每次调用占用的 token 估算。

## 9. 权限

1. 路径边界：解析真实路径，越出工作区或经符号链接逃逸一律拒绝；`.env*`、`.git/`、`.baton/shadow.git`、凭证文件默认拒绝。
2. 默认策略：读放行；写工作区放行（每次写运行前有快照）；执行命令询问，可设白名单和黑名单；联网询问。每个 agent 可以覆盖：写文件、执行命令、联网各自是「允许 / 每次问我 / 禁止」。写文件设成「每次问我」时，每次改动前弹审批卡，卡里是这次改动的预览（新文件内容、替换前后的行，或补丁原文）；Cursor 的改文件请求同样转到审批。旧卡片里的 `write: true / false` 读作「允许 / 禁止」。
3. 拦截点：Pi 工具在执行前统一过权限判断；Cursor 的 `session/request_permission` 转到工作台审批；MCP 工具在服务端过同一套判断。启动 Cursor 不加 `--force`。
4. 审批卡预览 diff 或完整命令，超时按拒绝处理。
5. 凭证存 `~/.baton/credentials.json`（0600），不发到浏览器、不给工具读；shell 环境变量去掉凭证。Cursor 登录由它的 CLI 保管。
6. 每次工具调用写入 `audit.jsonl`。

局限：shell 以本人系统用户身份运行，第一版没有容器隔离。

## 10. 快照与回滚

每次写运行开始前，用影子 Git（`.baton/shadow.git`，work tree 为工作区）提交一次快照。运行详情页显示这次运行的 diff，可以一键回滚到运行前。

## 11. 架构

```
apps/web        Vite + React + shadcn/ui 单页应用，只通过 HTTP/WebSocket 与服务通信
apps/server     本地服务：HTTP + WebSocket，凭证、登录、审批、运行调度
packages/core   harness：工作区存储、规则拼装、记忆、路由、工具注册表、权限、执行器
packages/mcp    baton-mcp（stdio）与 baton 命令行，回调本地服务
apps/desktop    Electron 外壳：在主进程里启动同一个服务，窗口加载它提供的同一套界面
```

执行器：

- **Pi 执行器**：`@earendil-works/pi-coding-agent` SDK 的 `createAgentSession`，自定义模型运行时与工具，会话 JSONL 存到 `.baton/sessions/`。
- **ACP 执行器**：启动 `agent --model <id> acp`，按 ACP 流程 `initialize → session/new → session/prompt`，把 `session/update` 转成运行事件，把 `session/request_permission` 转给审批。
- **演示执行器**：pi-ai 的假模型，不需要任何账号即可跑通整条流程，用于开发与测试。

服务只监听 `127.0.0.1`。

### 11.1 桌面版

- **同一个服务**：网页版（`apps/server/src/main.ts`）和桌面版都通过 `apps/server/src/serve.ts` 的 `startServer` 启动服务，端口同为 47321，数据目录同为 `~/.baton`。两者不能同时开；桌面版遇到端口被占用时弹窗说明后退出。
- **同一套界面**：桌面窗口直接加载 `http://127.0.0.1:47321/`，也就是服务在生产模式下托管的 `apps/web` 构建产物。窗口内不开放 Node 能力（`contextIsolation`、`sandbox`），界面仍然只走 HTTP 和 WebSocket；外部链接（如 ChatGPT 登录页）交给系统浏览器打开。
- **生命周期**：单实例。关掉窗口即退出应用，macOS 上也一样；退出前 `stopAll` 取消所有运行中的 agent（子进程随之结束），把线程写盘，再关闭端口。
- **打包**：`pnpm desktop` 先构建界面，再用 esbuild 把桌面主进程、服务、`baton-mcp` 各打成一个文件，连同界面产物和模拟 Cursor 一起放进 `apps/desktop/build/app`，最后用 `@electron/packager` 生成 `apps/desktop/out/Baton-darwin-<arch>/Baton.app`，并做 ad-hoc 签名（不做正式签名和公证）。`BATON_RESOURCES` 环境变量告诉服务这些资源在包里的位置。
- **Node 命令**：包里没有单独的 Node。服务需要用 Node 运行的脚本（`baton-mcp`、模拟 Cursor）一律用 Electron 自己的可执行文件，加 `ELECTRON_RUN_AS_NODE=1` 启动，见 `state.ts` 的 `nodeScriptCommand`。
- **PATH**：从访达启动的应用只有系统最小的 PATH，找不到 Cursor CLI 和 git。启动时读一次登录 shell 的 PATH 并合并进来。
- **日志**：桌面版没有终端，启动和退出记录写到 Baton 数据目录下的 `desktop.log`（默认 `~/.baton/desktop.log`）。
