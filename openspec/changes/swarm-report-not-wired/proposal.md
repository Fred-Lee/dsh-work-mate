# Report What Swarm Actually Did, Instead of "Not Wired"

## Why

归档编排里那一步永远打印：

```
swarm orchestrator not wired — parallel execution pending (design D1)
```

用户看到这句会合理地问"为什么按设计跳过？"——**措辞把"设计上不派发执行"读成了"功能没写完"**，
而真正的 swarm 门（未合并任务拦归档，`orchestrate.ts:257`）其实一直在工作。一步含糊的日志，
会让人对整个编排的可靠性打折扣。

## What Changes

`swarm` 步骤改为**如实报告本提案用了什么**（仍不派发执行，守 D1）：

| 情形 | 状态 | 摘要 |
|---|---|---|
| 无 swarm 任务 | `ok` | 「无 swarm 任务（本提案未使用任务级并行；派发执行由调用方/Agent Teams 决定，见设计 D1）」 |
| 全部已合并 | `ok` | 「N 个 swarm 任务全部已合并（分支：…）」 |
| 有未合并（force 放行） | `skipped` | 列出遗留任务与状态、分支，并指回 `workmate_swarm_task action=merge` |
| 显式传入外部 runner | `ok`/`failed` | 行为不变（该 hook 保留） |

## Impact

- `src/features/archive/orchestrate.ts` + 用例更新（原断言 `swarm: skipped` → `ok`）与 2 个新用例。
- 语义零变化：不新增派发能力，只把事实说清楚。
