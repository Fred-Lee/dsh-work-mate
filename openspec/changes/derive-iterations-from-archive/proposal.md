# Derive Iterations from the OpenSpec Archive

## Why

导出到 vault 后 `iterations: 0`——因为 `internal-homework` 从未走过 WorkMate 提案流程，
而迭代笔记的数据源此前只有提案。但该项目其实有**完整的历史**：`openspec/changes/archive/`
下 **62 个已归档变更**，目录名带日期、`## Why` 带一句话背景、`## Impact` 带受影响的代码路径。

把它们读成迭代，依赖图谱立刻就有内容——而且**不编造关系**：只有声明的 `relatesTo` 才算
`depends_on`；按时间推出的"上一个迭代"单独叫 `sequence` 并在 front-matter 标 `derived: true`。

## What Changes

1. **归档迭代**（`src/features/wiki/iterations.ts`）：
   - `2026-01-30-add-option-percent-statistics` → `{date, id}`；标题取 `# 标题` 行，缺省用 slug 人性化；
   - `## Why` 首行作摘要；`## Impact` 里反引号包裹的**代码路径**作 `touches`；
   - 一次 `git log --all --format=%h%x09%s` 扫描 `[proposal:<id>]` 标记 → 迭代↔提交；
   - 按日期排序，`sequence` 指向前一个迭代（**派生**血缘）。
2. **合并**：提案派生的迭代为准，归档补齐历史（同 id 提案优先）。
3. **渲染**：迭代笔记加入日期/摘要/`touches`（能匹配到模块的变成 `[[模块]]` 链接）/上一迭代；
   front-matter 增加 `date` / `origin` / `derived`；索引表加日期列。

## Capabilities

### 修改的能力

- `vault-export`：迭代来源扩展到 OpenSpec 归档（声明的依赖 vs 派生的血缘，二者分开标注）。

## Impact

- 新增 `iterations.ts` 与测试；`vault.ts` 迭代字段与渲染；`src/index.ts` 合并两路来源。
- **诚实边界**：归档里没有声明依赖就不画依赖边；`touches` 与 `sequence` 都标明是推导结果。
