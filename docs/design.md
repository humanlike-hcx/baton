# Baton 设计文档

本文档讲怎么实现。要做什么、验收标准和当前进度见 [`spec.md`](spec.md)，两者冲突时以 spec 为准。

多模型对话工作台：把已订阅的模型登录进来，打开就是对话框，随时换模型接着聊；改了文件之后可以让另一个模型检查。每个对话属于一个项目（工作区），同一个项目里的模型共用一套文件、上下文、记忆和工具，不同项目的对话可以同时在跑。单人、单机，本地网页和 Electron 桌面版是同一套。

## 1. 范围

两个订阅之间每个模型家族只走一条线路；API key 账号可以接任何服务，和订阅重复的模型也保留（2026-10-27）：

| 运行时 | 额度来源 | 模型 | 说明 |
|---|---|---|---|
| Pi（我们的循环） | ChatGPT 登录（Sign in with ChatGPT，或与 Codex CLI 相同的 Codex 账号登录） | GPT 系 | 订阅里 GPT 只走这一条 |
| Cursor Agent（通过 ACP） | Cursor 登录（`agent login`） | Cursor 账号可用的非 GPT、非 DeepSeek 模型 | 过滤掉 GPT 和 DeepSeek 家族，不提供 Auto |
| Pi（我们的循环） | 任意多个 API key 账号 | 这个服务的全部模型（包括 GPT） | 按量计费，见下面「API key 账号」 |

**思考档位**（US-100）：Pi 线路的档位来自模型目录的 `thinkingLevelMap`：标成 `null` 的不列出，`xhigh` / `max` 只有目录点名了才列出，发到接口是同一个值的别名（Codex 把 `minimal` 发成 `low`）不单列。没有目录时只给普通档位。模型不推理就没有档位。对话记在 `model.thinking`，运行时传给 `createAgentSession` 的 `thinkingLevel`，服务端拒绝模型不支持的档位；只换档位时对话里提示「思考档位从…改成…」。没选档位时按 Pi 的默认「中」显示，这个模型没有「中」就就近取一档，菜单里不另加「默认」。Cursor 把档位编在模型名里（`-low`…`-max`、`-thinking`、`-fast`，前后顺序不固定），`cursorVariant` 把它们拆成基础模型和变体，界面按基础模型合并成一行，换档位就是换成同一基础模型的另一个变体。模型菜单里档位收成一行子菜单，当前档位写在这一行上；有快速变体的模型在同一菜单里用「快速」开关切换。GPT-5.6 和 GPT-6 的「快速」不是变体：打开后同一次请求带 `service_tier: "fast"`（Pi 的简易流不会转发这个字段，所以执行器改走对应的 `stream`）。

**上下文圆圈**（US-98）：Pi 运行结束时取 `session.getContextUsage()`，记在运行的 `context: {tokens, window}`；界面取这个模型在这个对话里最近一次回复的数字，还没回复时按模型的窗口算 0%。Cursor 不报告用量，圆圈显示「—」并说明原因。

**输入框**（US-99）：新对话和对话页共用 `Composer`：权限胶囊（只读 / 每次问我 / 允许直接改，后者橙色；每档的一句说明只出现在这个菜单里）、模型胶囊（模型名 · 档位，下拉里用子菜单切档位、用开关切快速，或「换模型…」）、圆形发送按钮；下面一行是项目、对话编号、花费和上下文圆圈。

**API key 账号**（US-101）：
- 账号记在 `~/.baton/keys.json`（服务模板、显示名、Pi provider、自定义地址和模型列表），key 本身只在凭据文件里，存在账号的 provider 名下。线路记为 `source: "key"`，对话和运行另记 `provider` 和账号名。
- 模板见 `packages/core/src/keys.ts`。Pi 内置目录里有的服务（Anthropic、Gemini、DeepSeek、Kimi、智谱、OpenRouter、xAI、Mistral、Groq…）直接用 Pi 的目录：模型、上下文窗口、价格、思考档位都来自那里，key 存在同名 provider 下。OpenAI 的 key 不能放在 `openai` 下（那是 Sign in with ChatGPT 的位置），所以把 OpenAI 的目录复制注册成 `openai-key`。其余服务（通义百炼、硅基流动、本地 Ollama、任意 OpenAI / Anthropic 兼容地址）注册成 `custom-<编号>`，模型列表来自服务的 `/models`，拉不到时可以手填模型名。
- 只按「只有一家会发」的前缀自动认出模板（`sk-ant-`、`sk-or-`、`AIza`、`xai-`、`gsk_`、`fw_`、`sk-proj-`）；`sk-` 这种很多家都用的前缀不猜，让用户选。不会拿一个 key 去多家服务试。
- 服务返回的错误信息里可能引用请求，展示前把长串打码。
- 早先单独保存的 DeepSeek key（凭据里有 `deepseek`、还没有 `keys.json`）在启动时自动变成一个 DeepSeek 账号；旧对话里 `source: "deepseek"` 的模型和运行记录迁移成 `source: "key", provider: "deepseek"`。`/api/auth/deepseek` 保留为添加或移除 DeepSeek 账号的别名。房间上下文整理员仍然用 DeepSeek 账号。

ChatGPT 有两种登录方式，都走 ChatGPT 订阅，同一时间只保留一个凭证：

- **Sign in with ChatGPT**：Pi 的 `openai` provider，OpenAI 给第三方 agent 的入口，授权必须带 `chatgpt.tokens.use.direct`，不是每个账号都开放。
- **Codex 账号**：Pi 的 `openai-codex` provider，与 Codex CLI 是同一套 OAuth（同一 client ID、`localhost:1455` 回调），请求发到 `chatgpt.com/backend-api`。Pi 把它标成 legacy，所以只作备选。启动时如果 Baton 还没有 ChatGPT 登录，就从 `~/.codex/auth.json` 导入 Codex CLI 已经存好的 ChatGPT 登录（US-102）：`auth_mode` 必须空着或是 `chatgpt`，并且有 access token 和 refresh token。API key 模式不导入。导入只写进 `~/.baton/credentials.json`。之后 Pi 若刷新了这张 token，而 Codex 文件里的 refresh token 仍是刷新前那张，就把新的 access 和 refresh 写回去，`id_token` 保持不动。退出登录不删 Codex 的文件。ChatGPT 桌面端没有这份文件，不读。

GPT 线路的 provider 始终记为 `openai`；运行时 Pi 执行器按已登录的方式选 provider，两者都在时优先 Sign in with ChatGPT。模型页和选择框里的 GPT 模型列表也来自已登录的方式。Codex 账号能用的模型比较少（GPT-5.6 和 GPT-6 系列），选中的模型它没有时，运行在发请求之前就失败，并提示换模型。

不做：多人、账号体系、看板、聊天软件集成、容器沙箱、Claude 订阅 token。

## 2. 核心概念

- **工作区**（界面上叫「项目」）：一个本地目录。这个项目里的对话都读写这里的文件，工作台的状态放在 `<工作区>/.baton/`。打开过的项目列在侧边栏，每个对话属于其中一个，见 §11.1。
- **对话**（`Thread`）：只有这一种线程。记当前选中的「账号 + 模型」（`model: {source, model, name}`）和权限档位（`access`：`read` / `ask` / `allow`）。
- **运行**：一次回复（角色 `chat`）或一次检查（角色 `review`）。运行身份（`RunAgent`）由「账号 + 模型 + 权限」临时生成，id 是 `<账号>:<模型>`，名字是「模型名 · 账号」，不落盘；运行记录（`RunRecord`）照旧记运行时、模型和家族。
- 2026-10-27 之前还有 agent 卡片（`.baton/agents/*.md`）、接力线程、交接和顾问。现在都不再读取：旧的接力线程在打开工作区时跳过，旧对话保留（时间线里不认识的条目丢掉），选一个模型后可以接着聊。

## 3. 工作区目录

```
AGENTS.md                 # 公共规则，Pi 和 Cursor 都会读；由工作台维护其中的标记段
.cursor/mcp.json          # 工作台写入 baton MCP 服务
.baton/
  workspace.json          # 工作区设置：检查命令、命令黑白名单、禁止路径、预算、审批超时
  CONTEXT.md              # 房间上下文，整理预算默认 6KB，硬上限 8KB
  rules/
    base.md               # 共用底座
    role-chat.md          # 角色规则：对话、检查
    role-review.md
    runtime-pi.md         # 运行时校准
    runtime-cursor.md
    family-<家族>.md      # 可选，默认不启用
  memory/*.md             # 记忆条目（frontmatter 带状态）
  lessons/*.md            # 教训单
  threads/<对话>.json     # 对话与运行元数据
  tidy/<整理>.json        # 房间上下文的整理记录（整理前后原文、移进记忆的条目）
  sessions/               # Pi 会话 JSONL、ACP 事件日志（原始记录，长期保留）
  audit.jsonl             # 工具调用与审批审计
  shadow.git/             # 影子 Git，用于快照、diff、回滚
```

## 4. 上下文

### 4.1 开场注入（按「角色 × 运行时」拼装）

每次运行开始时现场拼装，顺序固定，方便命中提示词缓存：

1. `rules/base.md`
2. `rules/role-<角色>.md`（`chat` 或 `review`）
3. `rules/runtime-<运行时>.md`
4. 可选的 `rules/family-<家族>.md`
5. `CONTEXT.md`
6. 置顶记忆
7. 对话摘要：更早的对话（每轮一行，最多 30 行，存在 `thread.summary`）和最近 3 轮原文
8. 自这个模型在这个对话里上次回复以来的文件变化
9. 任务卡：「你是：模型名（模型 id）」、权限档位，以及用户这次的消息（检查时是「用户的要求」、检查命令结果、改动的文件和 diff）

**注入预算**：`budgets.briefing`（默认 24KB，不能小于 2KB）。超过时运行不会启动，时间线提示哪一段超了。模型页能查看任一模型以「对话」或「检查」启动时的开场上下文：每段的来源、大小、重复内容和哈希。

每次运行记录拼装结果的哈希，原始记录里能还原「当时它看到的是什么」。

工作区里还留着接力时代默认规则的规则文件（含「按阶段接力」「write_handoff」等字样）会被换成新的默认规则；`role-plan.md`、`role-implement.md`、`role-advisor.md` 删除。用户自己改过、不含这些字样的规则不动。

### 4.2 压缩

- 运行内：Pi 自带压缩（超过「窗口 − 16k」触发，保留最近约 20k token，结构化摘要），压缩时时间线写一条提示。Cursor 的压缩由它自己负责。
- 跨运行：换模型时不传原始会话，新模型从开场上下文里的对话摘要和最近 3 轮原文接上。
- `CONTEXT.md` 超预算时，整理员（Pi + DeepSeek）合并重复、把过时细节移进记忆，改动有 diff，可撤销：
  - 预算是设置里的 `budgets.context`（默认 6KB），不能超过 8KB 的硬上限；超过硬上限的写入直接拒绝。
  - 触发：任何一次写 `CONTEXT.md`（界面保存、agent 的 `update_context`）后，超预算就在后台自动整理；上下文页也可以手动「现在整理」。调低预算时也会检查一次。
  - 整理员是一次模型调用（`PiExecutor.complete`，真实工作区用 `deepseek-v4-pro`，演示工作区用脚本化的假模型），输入当前上下文、预算和已有记忆，输出 `{context, memories, summary}` 的 JSON。结果超预算、格式不对、或整理期间上下文又被改过，都放弃这次整理，原文不动。
  - 生效时先把细节逐条写进记忆（照常查重，被拒的记下原因），再写回 `CONTEXT.md`。每次整理存一份记录在 `.baton/tidy/<id>.json`，带整理前后原文，上下文页据此显示 diff。
  - 撤销：只能撤销最近一次生效的整理，而且整理后上下文没再改过；撤销时写回原文，把这次移进记忆的条目标为过时。被撤销或整理失败的那份原文不会再被自动整理，避免来回打转。
  - 没有 DeepSeek key（或关闭了记忆）时不整理，上下文页说明原因。整理的花费记在整理记录里，不计入任何对话。

## 5. 记忆与教训

三条去向：

- 长期不变的约束 → `AGENTS.md` / `rules/`
- 事实和偏好 → `memory/`
- 踩过的坑 → `lessons/`，再设法固化成权限规则、检查命令或测试

记忆条目字段：`id`、`kind`（fact / decision / preference）、`status`（active / superseded）、`supersededBy`、`author`（agent）、`run`、`pinned`、`createdAt`。不删除、不覆盖。写入前检索相近条目。检索用 SQLite 全文索引（或在不可用时退化为内存扫描），不用向量库。工作区可以关闭记忆。

教训单字段：`id`、`title`、`occurrences`、`status`（open / hardened / closed）、`hardenedBy`。同类问题出现第二次时提示固化。关闭条件：「这个坑现在还踩得到吗？」

**维护机制**：

1. 规则写进 `AGENTS.md` 和 `rules/base.md`。
2. 记忆写入校验 schema、长度、重复。

## 6. 对话

- 选模型：选择框列出 `/api/models` 里每条线路的全部模型，可搜索；线路没登录时整组不能选，并显示原因和去「模型」页的链接。服务端用线路的实时模型列表校验（`resolveModel`），不在列表里的模型拒绝；演示线路只在演示工作区里有。
- 每条消息触发一次回复；回复进行中（或排队中）发的消息记在 `thread.notes`，这一轮结束后合在一起接着回复；取消后不自动续上。
- 换模型：发消息时带上新的 `{source, model}`，时间线写一条「换成 X 接着聊（之前是 Y）」，新模型从开场上下文的对话摘要接上。
- 权限档位：`read`（默认）写文件和命令都禁止、联网询问；`ask` 写文件、命令、联网都每次问我；`allow` 都直接允许。黑名单、白名单、禁止路径和工作区边界在任何档位下照常判断。档位只对这个对话有效；回复进行中不能切换；服务重启时所有对话回到只读，并在时间线写一条提示。
- 写锁：同一工作区同时只有一个可写（档位不是只读）的回复，其他可写的回复排队（状态「排队中」），先快照再开始；只读的回复不排队。
- 工具：`chat` 角色有读文件、列目录、搜索、改文件、写文件、命令、读写房间上下文、查和写记忆、记教训；权限由档位决定。

**让另一个模型检查**（`POST /api/threads/:id/review {source, model}`）：

1. 校验：对话正在回复或排队时不能检查；只检查上次有结论的检查之后、改过文件的回复；检查者的线路要可用。
2. 选模型：界面默认推荐和最近一次改动作者不同家族的模型；同家族时界面提示，时间线也注明。
3. harness 先跑工作区配置的检查命令，结果作为一条 `checks` 贴进对话。
4. 检查者以 `review` 角色只读运行（写文件、命令、联网都禁止），开场上下文里带检查命令结果、改动的文件和 diff（超过 16KB 时截掉中间）。
5. 结论必须通过 `submit_review {verdict, issues}` 给出；不通过时要列出问题。运行结束还没给结论时追问一次；仍然没有就记为没有结论、时间线提示，可以重新检查。
6. 任何检查命令失败、出错或跳过时，结论不能是通过：模型判了通过也按不通过记，并在结论里注明（`overruled`），问题里加上「检查命令没有通过：…」。
7. 结论作为一条 `review` 贴回对话；检查期间用户发的消息，检查结束后接着由对话的模型回复。

**统计**：按「运行时 + 模型」记运行次数、成功与失败、改了文件的回复数、它的改动被别的模型检查时通过与不通过的次数、它替别人检查的次数、token 和花费。订阅线路的花费显示「订阅内」，API key 账号按实际花费换算成人民币（价格来自 Pi 的目录，自定义服务没有价格表时记为 0）。key 账号的统计行按账号分开。

## 7. 检查命令

在「让另一个模型检查」时先跑 `workspace.json` 里配置的命令，再交给模型审查。结果四种：通过、失败、跳过、出错，跳过绝不算通过。设置页可以试运行某条命令看输出。

## 8. 工具

一份注册表，每个工具登记：名字、描述、参数 schema（TypeBox）、风险等级（read / write / exec / network / memory）、执行函数、暴露范围（native / mcp）、按家族变化的呈现（编辑工具对 GPT 是补丁格式，对其他是文本替换）。

内置工具：`read_file`、`list_files`、`search`、`edit_file`（`apply_patch` 或 `replace`）、`write_file`、`shell`、`read_context`、`update_context`、`memory_search`、`remember`、`record_lesson`、`submit_review`（仅检查角色）。

出口：

- Pi：作为自定义工具注入，不加载 Pi 的默认资源发现。
- Cursor：本地 MCP 服务 `baton-mcp`，只暴露 4 个工具：`read_context`、`memory_search`、`remember`、`submit_review`。另有同等功能的 `baton` 命令行（`baton review pass|fail --issues …`）。

shell 工具：单独返回退出码；截断时保留开头和结尾，只砍中间，保留 stderr；每个工具有输出上限；时间线显示每次调用占用的 token 估算。

## 9. 权限

1. 路径边界：解析真实路径，越出工作区或经符号链接逃逸一律拒绝；`.env*`、`.git/`、`.baton/shadow.git`、凭证文件默认拒绝。
2. 策略：读放行；写文件、执行命令、联网按对话的权限档位（见第 6 节），检查一律禁止。命令按「黑名单 → 档位禁止 → 白名单（仅限不含管道、重定向等符号的简单命令）→ 档位允许 → 问我」判断。「每次问我」时每次改动前弹审批卡，卡里是这次改动的预览（新文件内容、替换前后的行，或补丁原文）；Cursor 的改文件请求同样转到审批。
3. 拦截点：Pi 工具在执行前统一过权限判断；Cursor 的 `session/request_permission` 转到工作台审批；MCP 工具在服务端过同一套判断。启动 Cursor 不加 `--force`。
4. 审批卡预览 diff 或完整命令，超时按拒绝处理。
5. 凭证存 `~/.baton/credentials.json`（0600），不发到浏览器、不给工具读；shell 环境变量去掉凭证。Cursor 登录由它的 CLI 保管。
6. 每次工具调用写入 `audit.jsonl`。

局限：shell 以本人系统用户身份运行，第一版没有容器隔离。

## 10. 快照与回滚

每次可写的回复开始前，用影子 Git（`.baton/shadow.git`，work tree 为工作区）提交一次快照，结束后再提交一次。时间线和运行详情里能看这次回复的 diff，可以一键回滚到它之前；检查读的也是这两个快照之间的 diff。

## 11. 架构

```
apps/web        Vite + React + shadcn/ui 单页应用，只通过 HTTP/WebSocket 与服务通信
apps/server     本地服务：HTTP + WebSocket，凭证、登录、审批、运行调度
packages/core   harness：工作区存储、规则拼装、记忆、路线规则、工具注册表、权限、执行器、对话编排
packages/mcp    baton-mcp（stdio）与 baton 命令行，回调本地服务
apps/desktop    Electron 外壳：在主进程里启动同一个服务，窗口加载它提供的同一套界面
```

执行器：

- **Pi 执行器**：`@earendil-works/pi-coding-agent` SDK 的 `createAgentSession`，自定义模型运行时与工具，会话 JSONL 存到 `.baton/sessions/`。
- **ACP 执行器**：启动 `agent --model <id> acp`，按 ACP 流程 `initialize → session/new → session/prompt`，把 `session/update` 转成运行事件，把 `session/request_permission` 转给审批。
- **演示执行器**：pi-ai 的假模型，不需要任何账号即可跑通对话、改文件和检查，用于开发与测试。演示线路的两个模型（「对话」「检查」）只在演示工作区里出现。

服务只监听 `127.0.0.1`。

### 11.1 多项目

- **每个项目一套编排**：服务为项目列表里的每个工作区各开一个会话（`Session`：工作区、编排器、整理员、是否演示），启动时把列表里的项目全部打开。写锁、快照、审批、整理员都按项目分开，所以 A 项目的回复和审批不受 B 项目影响，「同一项目同时只有一个写运行」照旧。
- **当前项目**：只决定管理页（上下文与记忆、统计、设置）显示哪个项目、新对话默认开在哪、`/api/models` 是否列出演示线路。`POST /api/workspace/open` 只是切换，不再要求先取消运行；第一次打开的项目放到列表最前，切换不改列表顺序。`POST /api/workspace/close` 把项目从列表移除，不删文件；有对话在进行时拒绝，移除当前项目时切到列表里的下一个，至少留一个。
- **按编号找项目**：对话、审批、运行的接口按编号在所有项目里找，不看当前项目。`POST /api/threads` 可以带 `workspace` 指定项目。演示模型能不能用、Cursor 是否登录、Cursor 模型列表，都按对话所在项目判断（Cursor 的状态和模型列表按 CLI 命令缓存，每个项目可以配不同的命令）。
- **工具桥**：MCP 和 `baton` 命令行带运行令牌时，找持有这个令牌的项目；不带令牌时，只有所有项目加起来恰好一个 Cursor 运行才归给它，否则按「用户手动调用」在当前项目里执行。
- **推送**：WebSocket 上的对话事件和整理事件带 `workspace` 字段，界面据此更新侧边栏里对应项目的对话列表。`/api/state` 的 `projects` 列出每个项目和它的对话摘要。
- **界面**：侧边栏按项目分组，可折叠，每组有「在这个项目里新建对话」；打开别的项目的对话时，界面调用切换，让管理页跟着这个对话的项目走。新对话输入框旁边可以选项目。
- **选择文件夹**（US-97）：`POST /api/workspace/pick` 由服务弹出系统文件夹选择框。macOS 上是 `osascript` 调起的 `choose folder`，先激活 Finder 让窗口到前面。Windows 上是 `powershell.exe -STA` 打开的 `FolderBrowserDialog`（可选新建文件夹，窗口置顶）。返回选中目录的真实路径，取消则 `{cancelled: true}`。同一时间只开一个。网页拿不到本机绝对路径，所以不能用浏览器的目录选择。界面在设置页、侧栏和「打开其他项目…」三处调用，选中后再走 `POST /api/workspace/open`；手填路径保留。其他系统说明没有选择框。测试注入自己的选择函数，不弹真窗口。

### 11.2 桌面版

- **同一个服务**：网页版（`apps/server/src/main.ts`）和桌面版都通过 `apps/server/src/serve.ts` 的 `startServer` 启动服务，端口同为 47321，数据目录同为 `~/.baton`。两者不能同时开；桌面版遇到端口被占用时弹窗说明后退出。
- **同一套界面**：桌面窗口直接加载 `http://127.0.0.1:47321/`，也就是服务在生产模式下托管的 `apps/web` 构建产物。窗口内不开放 Node 能力（`contextIsolation`、`sandbox`），界面仍然只走 HTTP 和 WebSocket；外部链接（如 ChatGPT 登录页）交给系统浏览器打开。
- **生命周期**：单实例。关掉窗口即退出应用，macOS 上也一样；退出前 `stopAll` 取消所有运行中的 agent（子进程随之结束），把线程写盘，再关闭端口。
- **打包**：`pnpm desktop` 先构建界面，再用 esbuild 把桌面主进程、服务、`baton-mcp` 各打成一个文件，连同界面产物和模拟 Cursor 一起放进 `apps/desktop/build/app`，最后用 `@electron/packager` 生成 `apps/desktop/out/Baton-darwin-<arch>/Baton.app`，并做 ad-hoc 签名（不做正式签名和公证）。`BATON_RESOURCES` 环境变量告诉服务这些资源在包里的位置。
- **Node 命令**：包里没有单独的 Node。服务需要用 Node 运行的脚本（`baton-mcp`、模拟 Cursor）一律用 Electron 自己的可执行文件，加 `ELECTRON_RUN_AS_NODE=1` 启动，见 `state.ts` 的 `nodeScriptCommand`。
- **PATH**：从访达启动的应用只有系统最小的 PATH，找不到 Cursor CLI 和 git。启动时读一次登录 shell 的 PATH 并合并进来。
- **日志**：桌面版没有终端，启动和退出记录写到 Baton 数据目录下的 `desktop.log`（默认 `~/.baton/desktop.log`）。
