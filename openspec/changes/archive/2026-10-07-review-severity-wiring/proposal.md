# Prove the Review-Severity Node's Wiring

## Why

六个判断节点里 `review-severity` 是**唯一没有真机事件**的：它只在归档编排的 review 门里跑，
而真机验收时该门因"读不到 review.md"直接失败（路径问题，已在 `archive-evidence-after-move` 修好）。
路径修好后，还需要**证明这条链路本身正确**——否则"没跑过"和"跑不通"分不清。

## What Changes

1. 导出 `gradeUntaggedFindings`（审查归级的唯一入口），使其可被直测；
2. 新增 3 个用例：
   - **逐条询问判断层**，问题 `node: 'review-severity'`、选项恰为 `['CRIT','HIGH','MED','LOW']`，
     仅采信 `act` 档答案，并保留 `JUDGED-n` 标记；
   - **弃权不编造**：判断层 `abstain` → 不产出任何分级（宁可漏，不造）；
   - **遵守上限**：`max` 参数生效。

## Impact

- `src/features/archive/orchestrate.ts`（导出）+ 1 个测试文件；行为不变，只把链路变可证。
