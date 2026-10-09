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

- **无法在本会话内看到修复"活"起来**：`workmate_plan_drift` 由**已装载的插件**执行，
  而插件跑的是 `dist/` 产物；本会话按纪律不重启 harness，因此工具返回值仍是旧逻辑
  （实测：修复并 `git commit` 后再次调用，输出里依然没有 `excluded` 字段，
  `missing` 里仍有那两条）。**这不是推测，是本次调用可复核的事实。**
  结论：本次以单测产物作为证据；真机生效需用户在面板重启 harness。
  重启后预期：`workmate_plan_drift` 的 `drift` 里出现 `excluded`，
  `missing` 不再含 `openspec/changes/**` 项。
- **解析器仍把文档里的示例注释当声明**：这是"用注释表达结构"的固有代价。
  本提案只消除了自己文档里的示例，没有改解析器语义（改它需要一套"示例区"标记，
  另开提案更合适）。

## 建议补充项

- 重启 harness 后复跑三份提案的 `workmate_plan_drift`，把 `excluded` 是否出现记进
  `docs/DSH-INTEGRATION-NOTES.md` 的证据等级表（本次会话做不到）。

## CRITICAL 问题

无。

## 明确没验什么

- **没验**：真机（重启后）的 `workmate_plan_drift` 输出——见"疑问项"，本会话禁止重启。
- **没验**：`planDriftGate: true` 下的端到端归档（本机 profile 未开该门，
  只用编排级单测覆盖了 warn/failed 两条分支）。
- **没验**：多项目（多 target）混合时 warn 的合并输出（单 target 已覆盖）。

## 审查者与独立性（诚实声明）

本文件由写代码的同一个 agent 写成 —— 按 `reviewerIndependence` 判据是 `same-as-author`（自评）。
`<!-- reviewer: -->` 如实写实现者身份，不假造独立审查者。

<!-- reviewer: honest-plan-drift-author -->
