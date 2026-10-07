# Archive Evidence Must Survive the Move

## Why

真机归档验收暴露两个问题：

1. **证据读不到**：归档编排读 `changes/<id>/tasks.md` 与 `review.md`，但 change 目录**已经**
   被移进 `changes/archive/<date>-<id>/`（上次归档尝试/复查）→ 步骤报
   `tasks.md not readable` 与 `审查报告缺失`，**`review-severity` 因此一次都没判**。
2. **自报失败与最终状态矛盾**：`mode: archive` 返回 `ok:false`（review 门 failed），
   但提案最终是 `archived`；返回值里也没有任何"本次是 force 跑的"标记。

## What Changes

1. 新增并导出 `resolveChangeDir(root, openspecRoot, changeId)`：**先活动路径，再回退
   `changes/archive/<date>-<id>/`**（按目录名后缀匹配、取最新）；tasks 门与 review 门都改用它；
2. `OrchestrationResult` 增加 `forced`（`reviewGate===false || tasksGate===false` 时为 true），
   成功返回里带上——**面板/调用方一眼就能知道本次是否绕过门禁**；
3. review 门失败文案标注 `reviewGate=on`，避免"失败了却归档完成"无从解释。

## Impact

- `src/features/archive/orchestrate.ts` + 直测 `resolveChangeDir` 的用例（活动路径优先、归档回退）。
- 语义零变化：只是把"读不到证据"变成"能读到证据"，并把 force 显式化。
