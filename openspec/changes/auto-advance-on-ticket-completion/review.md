# Review — Ticket 全部完成时自动推进到 merging

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认（代码级）：`reconcile` 的推进链止于 `ready`。`service.ts:639-647` 的
  `next` 三元链在 `implementing` 处返回 `undefined`；且无定时器调用它
  （`grep setInterval` 无命中，唯一入口是 REST）。
- [x] 确认（真机）：`support-multi-repo-executors` 的待办 `task-mw8rl3g9-2` 投影为
  `done/completed`，提案仍 `implementing`，reconcile 调用后不变——与上述代码事实一致。
- [x] 确认（分层）：`LifecycleService` 的 deps 里没有任务/执行器依赖
  （`grep deps.*task|ticket` 无命中），把 Ticket 判据塞进提案层会破坏依赖方向。
  故判据放在已持有 Ticket 的 `TaskService.board()`。
- [x] 确认：`merging` 的前置只查 wiki 关联（`service.ts:417-431`），不查 Ticket，
  所以自动推进到 `merging` 不会与既有门禁冲突；wiki 未完成时 transition 会抛错，
  按 D3 静默记 notes。

## 疑问项

- `dropped` 是否算"实现完成"？design D2 认定为是（需求无需实现）。风险：若全部待办
  都被 dropped，自动推进到 merging 后 `archiving` 的合并前置会因缺 `featureBranch`
  而失败。但这比卡在 implementing 更早暴露问题，且错误信息可读。保留该判定。

## 建议补充项

- 自动推进应在事件流留 `actor: 'system'` 与判据快照（哪些待办 done），便于事后回答
  "为什么它自己动了"。任务 3 落实。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] 无未解决 CRITICAL 问题。
