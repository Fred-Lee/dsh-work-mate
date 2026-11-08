# Tasks — 写入竞态加固

- [ ] 1. 规格增量：`task-intake` 补"并发写 SHALL 串行、id/seq SHALL NOT 重复"；
  `proposal-middleware` 补"聚合读改写 SHALL 串行" <!-- writes: openspec/changes/harden-write-races/specs/** -->
- [ ] 2. `TaskService` 写方法（create/assign/stop/reopen/reply/ensureImplementationTasks）
  经单条 promise 链串行 <!-- writes: src/features/task/service.ts -->
- [ ] 3. `ProposalService` 写方法（upsert/patchFields/setStatus/addDecision/addApproval）
  经单条 promise 链串行 <!-- writes: src/features/proposal/service.ts -->
- [ ] 4. 并发用例：同 tick 并发 create×N id 唯一；并发 reply seq 连续；
  并发 setStatus/addDecision 无丢失 <!-- writes: src/features/task/task.test.ts, src/features/proposal/service.test.ts -->
- [ ] 5. 门禁全绿后归档
