# Archive 之后自动回写 Vault

## Why

用户已定型知识面为**本地 markdown + Obsidian**（放弃 WeKnora）。但导出目前必须有人记得主动执行
（工具 / `/workmate export` / REST）——**归档完成了、vault 却没更新**，知识面就会与事实漂移。
既然 Obsidian 是唯一知识出口，"归档即同步"应当是默认行为。

## What Changes

1. 编排新增可选钩子 `onArchived(proposal, targets)`：**归档成功后**执行（第 8 步 `vault-export`）；
2. **失败不阻断归档**：钩子抛错只记 `vault-export: failed`，说明里写明"不影响归档"；
3. `Config.wikiVaultAutoExport`（默认 **true**）；仅在配置了 `wikiVaultPath` 时接线——没配 vault 的部署零副作用；
4. `index.ts` 的钩子对每个归档目标项目调用导出，并把"模块/页/迭代"摘要写进该步骤。

## Impact

- `src/features/archive/orchestrate.ts`（钩子 + 步骤类型）、`src/index.ts`（接线）、`src/config.ts`、
  `src/config.test.ts` + 2 个编排用例。
- 语义不变：归档门、manifest、worktree 清理都不受影响；导出失败也不改变归档结果。
