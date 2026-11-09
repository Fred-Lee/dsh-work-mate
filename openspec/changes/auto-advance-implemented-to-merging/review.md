# Review — 实现完成时自动推进到 merging（低频调度器版）

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认（真机事故）：上次实现导致宿主主线程 100% 卡在
  `v8::MicrotaskQueue::RunMicrotasks`，3080 无响应、`SIGTERM` 无效。回滚后恢复。
- [x] 确认（代码级）：`board()` 有三个调用者，其中 `/api/tasks` 与
  `/api/worktrees/leftover`（`index.ts:596`）会被面板同时请求 → `board()` 并发执行。
  这是上次"越滚越多"的结构性原因。
- [x] 确认（代码级）：`transition` → `setStatus` → `store.save`（串行化链）
  与 `board()` → `store.load` 共享同一个 `ProposalServiceImpl` 写锁链；
  在读路径里发起写会自我排队。
- [x] 确认：判据部分（`implementationComplete`）上次是对的，本变更沿用，但移到
  独立模块并**不再从 board 调用**。
- [x] 确认：`autoAdvancedAt` 加进 `PATCHABLE` 白名单即可持久化，不需要改 store 结构
  （`proposals.json` 是自由形状 + 白名单校验）。

## 疑问项

- 60 秒间隔是否合适？若 worker 完成后人等待超过 1 分钟才看到「待合并」，是否可接受？
  取 60s：面板本身 5s 轮询，但推进是低频行为，1 分钟延迟远小于人点按钮的反应时间。
  这个值放 `Config.advanceScanSeconds`（默认 60），可调。

## 建议补充项

- 事故回归用例（任务 5）是本变更的**验收核心**。若它不能稳定复现"并发下不死锁"，
  本变更不应归档。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] CRIT-1 **上次的事故可能重演**：只要推进仍在任何被高频调用的路径上，就会再次
  死锁。缓解：本变更把推进完全移出读路径，并由任务 5 的并发用例守住。
  **任务 5 已通过**（并发 50 次读 + 扫描交错，5 秒内完成、只推进一次），此条已解决。
