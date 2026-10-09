# swarm 任务产出接独立核验：合并 ≠ 有人看过

## Why

来源：与 `harden-archive-gates` 同一次调研（dsh-graph 的独立评审归因），以及对当前 swarm
实现的**代码核实**。

问题（代码事实）：

1. `SwarmTaskRecord` 的状态只有 `planned | running | merged | failed`
   （`src/features/swarm/manager.ts:15-31`）——"已合并"就是终点。合并只证明代码落地，
   **不证明有人看过**。
2. 归档编排的 swarm 步骤在 `swarmPending.length === 0` 时直接判 ok
   （`src/features/archive/orchestrate.ts:358-370`），没有"逐个任务被独立核验"的概念。
3. 于是"多任务并行"的产出质量完全依赖调用方自觉：把写码的同一个 agent（或写码者自己）
   的复核当核验，编排层看不出来——这是 `harden-archive-gates` 在审查门上修掉的同一个洞，
   只是位置移到了 swarm。
4. 复用的独立性判定已随 A 提案落地（`src/features/quality/reviewer-independence.ts`），
   语义一致：`independent` / `same-as-author` / `missing` / `undetermined`。

**明确不做「PK 多路 attempt」**：dsh-graph 自己的 host 侧 `lanes` 零命中（是空壳），
且与 swarm 语义重叠。本变更只做"每个任务产出的独立核验记录 + 可选归档门"，
"选哪个产出"留给调用方，不造第二套语义。

## 来源 / Provenance

- source: `review-finding`
- sourceRef: `https://github.com/miuzel/dsh-graph`

### intent 形状

- **Problem**：swarm 的"已合并"被当成"已完成"，没有任何机制记录"谁核验过这个任务的产出"，
  更不区分核验者是否独立于该任务的提交作者。
- **Proposed outcome**：新增 `workmate_swarm_task action=verify`（reviewer + verdict + evidence），
  `SwarmManager.verify` 从 git 读该任务的提交作者并派生独立性判定，记录写进
  `SwarmTaskRecord.verification`；`Config.swarmReviewRequired`（默认 `false`）开启后，
  归档门会拦"有已合并任务但缺独立核验记录"的提案。
- **Affected users and systems**：swarm 的调用方（多一步 verify，或显式关掉门）；
  归档门的 swarm 步骤新增一条失败语义；`proposal.swarmTasks[]` 结构新增可选字段。
- **Constraints**：不新增依赖；默认关闭以免打断既有提案；**未合并的任务不得被核验**
  （合并是前提，不是替代）；核验者必须署名（不署名就只是"看起来核过"）；
  无法取到 git 事实时判 `undetermined` 并**不算**独立核验（宁可拦住，也不假装通过）。
- **Open questions**：`undetermined` 是否该在 `swarmReviewRequired` 下阻断？本变更选**阻断**
  （与审查门相反）。理由见 design D3 —— 这条差异是有意的，不是不一致。

## What Changes

- **`SwarmTaskRecord.verification`**（可选）：`{ reviewer, verdict: 'verified'|'issues',
  evidence?, independence, note, at }`；重新 plan 时保留已有核验记录。
- **`SwarmManager.verify(proposalId, taskId, { reviewer, verdict, evidence? })`**：
  ① 未 `merged` 直接拒绝；② `reviewer` 空白直接拒绝；③ 从 `repoRoot()` 读该仓库提交 author
  集合，用 `judgeReviewerIndependence` 派生独立性；④ 写回记录并返回判定与说明。
- **`workmate_swarm_task action=verify`**：新增 action；缺 `reviewer` / `verdict` 明确报错；
  `same-as-author` 时在返回里带 `warning`。
- **归档门**：`Config.swarmReviewRequired`（默认 `false`）为 true 时，
  所有已合并任务都必须有核验记录且独立性不是 `same-as-author`，否则 swarm 步骤 `failed`
  并逐个点名（`t2(未核验)` / `t1(核验者 X 与提交作者同一身份)`）。
- **文档**：`AGENTS.md` 归档门禁表 + 流程 skill 的 swarm 小节写明 verify 步骤与门禁。

## Impact

- 影响文件：`src/features/swarm/manager.ts`、`src/features/swarm/manager.test.ts`、
  `src/features/archive/orchestrate.ts`、`src/features/archive/orchestrate.test.ts`、
  `src/features/archive/service.ts`、`src/index.ts`、`src/config.ts`、`src/config.test.ts`、
  `AGENTS.md`、`src/features/guidance/content.ts`。
- 规格：新增 capability `swarm-verification`（见 `specs/`）。
- 兼容性：默认 `false`，既有提案行为不变；开启后是多一道要求（需要每个已合并任务被独立核验）。
- 范围外：不做 PK 多路 attempt / 不做"择优"自动裁决；不做跨任务的一致性审查（那属于审查门）。
