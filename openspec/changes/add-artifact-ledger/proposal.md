# Add Artifact Ledger (declared vs actual + plan drift)

## Why

playbook 把"工件链"当作闭环的骨架，并要求**可追溯性至少到"每个工件注明记录 id 与提交 SHA"**
（[P1] "Linkage as the minimum bar"）；waydev 那篇的追问是「tech lead 怎么确认 merged diff
仍然匹配 commit 的 plan.md？」——这正是**计划漂移**问题。

WorkMate 现在有工件（`proposal.md`/`design.md`/`tasks.md`/`review.md`）与提交关联
（`[proposal:<id>]` 标记），但**没有任何地方把"声明要改什么"与"实际改了什么"对起来**：
`tasks.md` 里的 `<!-- writes: src/a/** -->`（swarm 阶段已解析）从未与实际 diff 比对，
归档 manifest 也只记提交与 diffstat。

## What Changes

1. **声明集合**（纯函数）：从 `tasks.md` 的 `<!-- writes: ... -->` 与 `design.md` 的
   `<!-- files: ... -->` 收集"声明要动的文件范围"。
2. **漂移计算**（纯函数）：`computeDrift({declared, actual})` → `undeclared`（改了但没声明）、
   `missing`（声明了但没改）、`driftRatio`。
3. **实际集合**：由提案的标记提交算 `git diff --name-only <oldest>^..<newest>`。
4. **工件账本**：归档成功后逐项目记录归档目录里的工件（`proposal.md`/`design.md`/`tasks.md`/
   `review.md`/`wiki.md`/`commits.md` 等）的**路径 + sha256 + 字节数 + 标记提交**，
   写进 `ArchiveManifestEntry`。
5. **工具 `workmate_plan_drift`**：归档**之前**就能查"我声明的和实际改的对得上吗"，
   让 agent 先补声明或改实现。
6. **可选的归档门**：`Config.planDriftGate`（**默认 false**）为 true 时，存在未声明改动即
   归档失败并列出文件（`force` 可跳过）。默认关闭是刻意的：`writes` 声明是新约定，
   历史提案没有它，一上来就拦会把所有老提案卡死。

## Capabilities

### 新增能力

- `artifact-ledger`：声明集合、计划漂移计算、工件哈希账本与可选的漂移门。

## Impact

- 新增 `src/features/proposal/artifacts.ts` + 测试；`orchestrate.ts` 采集 drift 与账本；
  `config.ts` 加 `planDriftGate`；`index.ts` 加 `workmate_plan_drift`（共 15 个工具）；
  client 交付物小节显示漂移摘要。
