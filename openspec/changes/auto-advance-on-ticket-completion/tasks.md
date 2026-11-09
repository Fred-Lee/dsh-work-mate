# Tasks — Ticket 全部完成时自动推进到 merging

- [x] 1. 规格增量：`lifecycle-state-machine` 补 `implementing → merging` 的自动推进判据；
  `task-intake` 补"完成即推进" <!-- writes: openspec/changes/auto-advance-on-ticket-completion/specs/** -->
- [x] 2. `TaskService`：board 观察到"某提案全部待办 done 且至少一条"时，调用注入的
  `onProposalComplete(proposalId)`；判据实现为纯函数便于单测 <!-- writes: src/features/task/service.ts -->
- [x] 3. `src/index.ts`：装配回调 → `archive` 侧推进 `implementing → merging`
  （失败只记 notes） <!-- writes: src/index.ts -->
- [x] 4. 用例：全 completed → 触发；含 closed/stopped → 不触发；有待办在跑 → 不触发；
  无待办 → 不触发；重复观察只推进一次 <!-- writes: src/features/task/task.test.ts -->
- [x] 5. 门禁全绿 + 真机验证 support-multi 自动进 merging
  <!-- writes: （无源码写域；仅运行命令与记录） -->
