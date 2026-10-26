# 给进入本仓库的 agent

1. 开始工作前先读 `docs/spec.md`：它规定了要做什么、验收标准和每条需求的当前状态。`docs/design.md` 讲怎么实现，两者冲突时以 spec 为准。
2. 只做 spec 里有编号的用户故事（`US-编号`）。要做 spec 里没有的事，先请用户确认并把它补进 spec。
3. 提交信息用约定式提交（feat / fix / chore / docs / refactor / test），并引用故事编号，例如 `feat(chat): add chat threads (US-17)`。
4. 完成一条故事时，在同一个提交里更新它在 spec 中的状态。只有在有自动化测试或手动验收步骤之后，才能标为「完成」。
5. 提交前运行 `pnpm typecheck` 和 `pnpm test`，都要通过。
6. 新测试优先写在本地 HTTP API 这一层（见 spec 的「测试决策」），外部依赖用 Pi 的假模型和模拟 Cursor CLI 代替。
