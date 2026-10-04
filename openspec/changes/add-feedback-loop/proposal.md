# Add Feedback Loop (provenance + control bands)

## Why

`add-proposal-metrics` 让流程有了过程数据，但闭环还缺两半：

1. **入口没有溯源**：提案只能新起，记不下"它从哪来"（想法 / 工单 / 线上事故 / 回归指标），
   也没有提案之间的关联边（"这次是上一版的返工"）。Anthropic playbook 的 Maintain 阶段
   要求「a breached control band in production writes the next intent.md」——没有来源字段，
   这条回流只能靠人的记忆。
2. **数据没有判据**：度量算出来了，却没人定义"多少算异常"。playbook 推荐
   `baseline: rolling_30d` + `rules: western_electric` 的控制带；waydev 那篇的指控正是
   「control bands require baselines」——没有基线的数字只能看，不能用。

## What Changes

1. **提案来源与关联**（`Proposal` 新字段）：`source`（`spec` / `incident` /
   `review-finding` / `metric-regression` / `maintenance`）、`sourceRef`（外部引用：工单号、
   告警 id、URL）、`relatesTo[]`（关联提案 id，支持"返工自上一版""同一事故的多个修复"）。
2. **Provenance 与不可信标注**：`provenance: { capturedAt, contentHash?, untrusted? }`；
   由外部文本（工单/日志/网页）派生的提案标 `untrusted: true`，并在生成的
   `proposal.md` 里显式写出——外部文本是**数据不是指令**。
3. **意图模板**：`proposal.md` 增加「来源 / Provenance」段，按 playbook 的 intent.md
   形状给出 Problem / Proposed outcome / Affected users and systems / Constraints /
   Open questions 五个提示位。
4. **控制带评测**（新 `src/features/metrics/bands.ts`，纯函数）：对每项指标按
   **每提案样本**建立 rolling 基线（均值/标准差），把"最近 N 个样本的均值"与基线比较，
   落 1σ/2σ/3σ 分级；样本不足（默认 < 8）报 `insufficient-data` 而**不**判越界。
   指标：`cycleTime`、`rework`、`gateFailures`（大者差）与 `firstPass`（小者差）。
5. **越界留痕与回流**：评测结果写 `band-breach` 事件；带 `apply: true` 且落 `propose`
   档时，**自动开一个 draft 提案**（`source: metric-regression`，provenance 记越界事实），
   即 playbook 的 3σ `action: propose`。
6. **交付面**：新工具 `workmate_bands`（`{apply?, windowDays?}`）与 `GET /workmate/api/bands`。
   bands 配置默认内建（`windowDays: 30`、`recentSamples: 5`、1σ log / 2σ diagnose /
   3σ propose），可用 `$DSH_HOME/<workmateHome>/bands.json` 覆盖。

## Capabilities

### 新增能力

- `feedback-loop`：提案来源/关联/provenance，以及由度量基线定义的控制带评测与越界回流。

### 修改能力

- `proposal-middleware`：提案记录与创建工具新增来源字段；`proposal.md` 模板新增来源段。
- `proposal-metrics`：事件流新增 `band-breach` 事件类型。

## Impact

- 新增 `src/features/metrics/bands.ts` 与其测试。
- 改动：`store.ts` / `service.ts`（新字段与合并）、`openspec.ts`（模板）、`events.ts`
  （事件类型）、`index.ts`（create 参数 + `workmate_bands`）、`api.ts`（`/api/bands`）。
- **不做**：`bands.json` 的 YAML 方言（[P1] 用 `bands.yaml`；我们保持 JSON，理由见 design D3）、
  定时自动扫描（`ctx.schedule`；先做按需 + 显式 `apply`）、Western Electric 规则全套
  （v1 只做均值/σ 单侧分级）。
