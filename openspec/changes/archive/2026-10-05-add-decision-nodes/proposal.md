# Add Decision Nodes (risk / review grading / injection / task judgement)

## Why

判断层（`add-decision-layer`）落地了机制与第一个消费者（决策矛盾检测），但它的价值在于
**把它接到真实的卡点上**。SDLC 流程里有四个封闭、可验证的判断节点至今靠机械规则或干脆空缺：

1. **风险分级**：提案没有风险等级，"分级自治"（高风险强制人工批准）无处落地；
2. **审查发现分级**：`review.md` 里只有带 `CRIT-` 标签的行进得了 tally，疑问/建议类发现
   永远不参与分级审查门；
3. **外部文本**：`provenance.untrusted` 全靠调用方自觉标注，没人标注就没有这层可见性；
4. **任务是否真的完成**：归档验收只看 `[x]` 勾选——勾了不等于 diff 满足那条任务。

## What Changes

1. **`risk-tier`**：新工具 `workmate_assess_risk`（读提案的 spec/design/tasks + 标记提交的
   diff 摘要，问固定三档）→ 写回 `Proposal.risk`；`Config.highRiskExtraGates`
   （默认 `['implementing']`）让 `risk: high` 的提案在这些状态也**必须人工批准**（收紧，
   与既有 `approvalsRequired` 叠加）。
2. **`review-severity`**：归档审查门在判断层可用时，对 `review.md` 里**未打标签**的发现
   （疑问项 / 建议补充项，单次最多 5 条）逐条问严重度，**只在 `act` 档**采信并合成
   `findings`，随后照常走分级 tally → 于是"被判为 CRIT 的疑问"会真的挡住归档。
3. **`injection-risk`**：创建提案时（带 `notes` 或 provenance）问一次"这段文本是否夹带
   指向 agent 的指令"；`act + risky` 时**自动置 `provenance.untrusted = true`** 并把结论
   记进 `decision` 事件——标注不再依赖调用方自觉。
4. **`task-satisfied`**：归档时对**已勾选**的任务（最多 3 条）问"这份 diff 是否满足这条
   任务"；结论写进 manifest（`taskJudgements`），`Config.taskJudgementGate` 默认 false
   （只记录），置 true 时未满足即阻断（`force` 可跳过）。

## Capabilities

### 新增能力

- `decision-nodes`：风险分级、审查发现分级、外部文本判定与任务完成判定的四个消费者。

## Impact

- 改动：`orchestrate.ts`（审查门分级 + 任务判定进 manifest）、`archive/service.ts`
  （高风险追加人工批准门）、`api.ts`（创建时注入判定）、`index.ts`（风险工具 +
  判断层注入 orchestrate）、`store.ts`（`risk`/`taskJudged` 字段）、`config.ts`
  （`highRiskExtraGates` / `taskJudgementGate` / `reviewGradeMax`）。
- **默认行为不变**：判断层未启用（默认）时四个节点全部不生效，流程与现在逐字一致。
- **只收紧**：四个节点都只能让门更严（追加人工批准、判为 CRIT 的发现进阻断集、
  自动置 untrusted、可选阻断），不会放宽任何既有门禁。
