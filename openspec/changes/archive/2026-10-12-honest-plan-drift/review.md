# Review — plan-drift 诚实化

## 确认项

- **幽灵 missing 的根因是可复现的**：`collectProjectDrift` 在
  `src/features/archive/orchestrate.ts` 里过滤 `openspec/changes/` 前缀生成 `actual`，
  却用未过滤的 `declared` 算 `missing`。实测证据（修复前的 `workmate_plan_drift` 输出）：
  三份提案的 `missing` 里都含 `"…"` 与 `"openspec/changes/<id>/specs/**"`。
- **修复落在纯函数层**：`computeDrift(declared, actual, { ignoredPrefixes })`，
  新增 `excluded` 字段。用例：
  - `reports declarations inside an ignored prefix as excluded, not missing`
    —— 断言 `excluded` 恰为 `['openspec/changes/p1/specs/**']`、`missing` 恰为 `['src/a/**']`；
  - `treats a scope equal to the ignored prefix as excluded too`
    —— 声明恰等于前缀时 `missing` 为空（这是双向判定的必要性证明）。
- **编排层真的传了前缀**：`does not count the plan directory itself as an untouched declaration`
  用真实 git 仓库跑 `collectProjectDrift`，断言 `drift.excluded` 与 `drift.missing` 分列正确。
- **warn 步骤不阻断**：`reports an untouched declaration as a warn step, never as a failure`
  断言 `plan-drift` 步骤 `status === 'warn'`、摘要含未触及声明、且 `result.ok === true`。
- **warn 不改变既有消费方**：逐一核对 `steps[].status` 的读取点 ——
  `service.ts:477` 查 `'failed'`；`service.ts:486` 只拼详情字符串；
  `src/client/api.ts:73` 的类型是 `status: string`。没有 `=== 'ok'` 的正向断言会被 `warn` 破坏。
- **示意行问题已在自己的文档上消除**：四份 `tasks.md` 里的说明行不再含注释形式的示例；
  `add-systemone-decision-provider` 的那份**未改**（不在本提案范围，已 `git checkout` 还原）。

## 疑问项

- ~~**无法在本会话内看到修复"活"起来**~~ **→ 已于重启后真机复核通过（见下"重启后复核"）**。
  修复前实测：插件跑 `dist/` 产物，且活实例是旧构建，`workmate_plan_drift`
  返回值里没有 `excluded`、`missing` 里仍挂着 `openspec/changes/<id>/specs/**`。
  这条曾是本变更唯一没有真机证据的部分。
- **解析器仍把文档里的示例注释当声明**：这是"用注释表达结构"的固有代价。
  本提案只消除了自己文档里的示例，没有改解析器语义（改它需要一套"示例区"标记，
  另开提案更合适）。

## 建议补充项

- ~~重启 harness 后复跑三份提案的 `workmate_plan_drift`…~~ **→ 已完成，见下"重启后复核"。**

## 重启后复核（真机，2026-10-10 08:04 之后）

用户重启 harness（新实例 PID 74355，`dist/index.js` 07:45:51 > HEAD 07:43:37）后复跑
`workmate_plan_drift`，四份提案结果一致：

| 提案 | `missing` | `excluded` |
| --- | --- | --- |
| `harden-archive-gates` | `[]` | `openspec/changes/harden-archive-gates/{specs/**,review.md}` |
| `harden-test-integrity` | `[]` | `…/{specs/**,review.md}` |
| `wire-swarm-independent-review` | `[]` | `…/{specs/**,review.md}` |
| `honest-plan-drift` | `[]` | `…/review.md` |

- **修复前**：`harden-test-integrity` 的 `missing` 为 `["…/specs/**", "…/review.md"]`，
  返回体里根本没有 `excluded` 字段。
- **修复后**：`missing` 清空、`excluded` 出现且恰好是那两条计划目录内的声明。
  与单测断言（`reports declarations inside an ignored prefix as excluded, not missing`）
  逐条吻合 —— 纯函数层与真机装载行为一致，没有"单测绿、真机不生效"的落差。
- **反向对照仍在**：`honest-plan-drift` 的 `driftRatio` 曾因漏声明 `src/index.ts`
  报 `0.1667` 且 `undeclared: ["src/index.ts"]`；补上声明（提交 `1e1e7f6`）后
  `undeclared: []`、`driftRatio: 0`。**真漂移没有被 `excluded` 掩盖**，
  计划目录豁免只吃计划目录自己的路径。

## CRITICAL 问题

无。

## 明确没验什么

- ~~**没验**：真机（重启后）的 `workmate_plan_drift` 输出~~ **→ 已验，见下"重启后复核"。**
- **没验**：`planDriftGate: true` 下的端到端归档（本机 profile 未开该门，
  只用编排级单测覆盖了 warn/failed 两条分支）。
- **没验**：多项目（多 target）混合时 warn 的合并输出（单 target 已覆盖）。

## 审查者与独立性（诚实声明）

本文件由写代码的同一个 agent 写成 —— 按 `reviewerIndependence` 判据是 `same-as-author`（自评）。
`<!-- reviewer: -->` 如实写实现者身份，不假造独立审查者。

<!-- reviewer: honest-plan-drift-author -->
