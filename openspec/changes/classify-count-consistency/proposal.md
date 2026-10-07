# 追溯补记：classify 诊断的计数口径与渲染一致

> 这是**事后补记**（retroactive record）：代码已由提交 `8edd38b` 实现并测试，当时漏了 OpenSpec 变更。
> 目的只是补齐追溯链，让"每个实现提交都有对应规格"成立。

## Why

真机核对发现：vault 迭代笔记的渲染用"slug 包含**或** token 重合"连线，而 `classify` 诊断只统计
"slug 包含"——于是首次实测报出 `pathMatched=0 / vectorMatched=11`，**虚高了向量的功劳**，
与实际的 44 篇有模块链接对不上。诊断口径不一致会让"判断层到底补了几条边"无法取信。

## What Changes

`classify` 的路径计数与渲染共用**同一判据**（slug 包含 OR token 重合），修正后真机实测：
`pathMatched=42 / vectorMatched=2 / llmAsked=0 / unanswered=20`（与 44 篇有链接完全对得上）。

## Impact

- `src/features/wiki/vault.ts`（计数判据）+ `src/features/wiki/vault.test.ts`（断言随口径更新）。
