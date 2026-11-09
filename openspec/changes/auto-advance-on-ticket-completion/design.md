# 设计：Ticket 全部完成时自动推进到 merging

## D1 判据放在执行事实，不放在提案层

`LifecycleService` 拿不到 Ticket（分层：提案层不依赖执行层）。硬把它接上会让
`archive/service.ts` 依赖 `SuperagentClient`，破坏现有依赖方向。

所以：**判据由已经持有 Ticket 的一方给出**——`TaskService.board()` 每 5 秒读一次
Ticket 投影，它知道每个待办的 lane。board 在观察到"某提案的全部待办都在 done 列"时
调用注入的 `onProposalComplete(proposalId)` 回调，由装配层决定怎么推进。

## D2 done 的定义

`lane === 'done'` 对应 `projectTask` 的判定：Ticket `ended` 存在。终态五值里
`completed` / `merged` / `dropped` 都算完成；`closed`（PR 关闭未合并）与 `stopped`
在投影里也进 done 列，但它们**不是实现完成**。

取舍：`closed` 意味着"没合并就关了"，`dropped` 意味着"无需处理"。两者都不该自动
推进到 `merging`（`merging` 的前置是"实现完成且可合并"）。因此 D2 采用：

- **可推进**：`completed`、`merged`、`dropped`
- **不推进**：有 `closed`、`stopped`，或任何非 done 的待办

`dropped` 算完成是因为需求本身被判定为无需实现；让它卡在 implementing 没有意义。

## D2b 至少要有待办

没有待办（例如 G2 从未交接、或待办被删）时不推进——否则一个空提案会被自动推进，
绕过"实现确实做了事"的证据。

## D3 触发与幂等

- 触发点在 `board()`：它在被面板轮询时天然每 5 秒跑一次，无需新定时器。
- 幂等：推进成功后提案状态不再是 `implementing`，下次观察自然不再触发。
- 静默失败：`transition` 抛错（wiki 关联、基线缺失等）只追加到 board 的 `notes`，
  不改变面板可用性。人能看到原因并按提示补。

## D4 不碰 G5

`implementing → merging` 不是人工门：G5 是 `merging → archiving`（合并 + 归档放行）。
自动推进到 `merging` 只是"实现做完了，等合并"，人仍要决定是否合并归档。这与
`lifecycle-state-machine` 现有"除 G2/G5 外由证据自动推进"一致。
