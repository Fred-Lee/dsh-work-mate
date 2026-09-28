# Add Archive Orchestration

## Why

里程碑四：把归档从「纯状态机」升级为**编排闭环**——收集 OpenSpec 任务快照、执行
`openspec archive`、重建 GitNexus 索引、落 `archived` 状态（设计文档 §3.1.4、§7
里程碑四）。

## What Changes

1. **编排引擎**（`src/features/archive/orchestrate.ts`）：五步流水线——任务快照 →
   （swarm 并行执行，D1 降级）→ `openspec archive <id> --yes` → `gitnexus analyze
   --force` → 状态 archived。每步产出 step 记录（状态 + 输出摘要），失败即停且
   提案状态不变（编排幂等，可重试）。
2. **工具语义升级**：`workmate_proposal_archive`（带 projectRoot 时）背后替换为
   编排引擎；工具签名不变（M2 契约）。纯状态机路径保留给无法解析项目根的提案。
3. **REST**：`POST /workmate/api/proposals/:id/archive` 同步走编排（编排耗时 =
   两次 CLI，秒级，无队列必要）。

## Capabilities

### 新增能力

- `archive-orchestration`：归档编排流水线及其降级语义。

## Impact

- 新增 `src/features/archive/orchestrate.ts`（子进程：openspec CLI + gitnexus CLI）；
  `service.ts` 的 archive 接编排引擎。无新增 npm 依赖。
- 已知边界（design D1）：`dsh-swarm-orchestrator` 未装入 profile 且包名未在 npm
  验证，本里程碑的「并行执行」步骤降级为记录性跳过；编排顺序与其余步骤不变，
  swarm 接入只替换步骤 2 的实现。
