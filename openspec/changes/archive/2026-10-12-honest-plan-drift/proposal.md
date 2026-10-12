# plan-drift 诚实化：计划目录不算漂移，未触及的声明也不该隐形

## Why

来源：为核验"plan-drift 门在本机可用"（补齐目标 ⑤），对 `harden-archive-gates` /
`harden-test-integrity` / `wire-swarm-independent-review` 三份提案实跑
`workmate_plan_drift`，暴露两个**实测**问题。

### 问题 1：幽灵 missing（判定自相矛盾）

三份提案的 drift 都出现：

```
missing: ["…", "openspec/changes/<id>/specs/**"]
```

根因在 `collectProjectDrift`（`src/features/archive/orchestrate.ts`）：它把
`openspec/changes/` 前缀从 `actual` 里过滤掉（注释写明"变更自己的 spec 目录是计划，
不是交付物"），却仍拿同一批声明去算 `missing`。于是**任何正确声明了自己 spec 文件的提案，
都会永远显示"声明了但没改"**——同一个前缀一边被排除、一边被要求出现。

### 问题 2：未触及的声明完全隐形

`planDriftGate` 只拦 `undeclared`（改了没声明）。`missing`（声明了没改）不阻断——
这本身是对的（计划声明范围后用别的路径覆盖是合法的，比如改名或共用模块），
但**归档记录里连一条提示都没有**，`workmate_plan_drift` 的结果也没人读。于是"计划写多了"
这个信号在本机等于不存在。

### 附带：示意行会被当成真声明

`tasks.md` 开头的说明行里若写了 HTML 注释形式的 writes 示例，`declaredScopes`
会把它解析成一条真声明（实测 `missing` 里出现 `"…"`）。本次已改写自身文档措辞，
但**解析器仍会这样解析任何文档里的示例**——这是"用注释表达结构"的固有代价，不改。

## 来源 / Provenance

- source: `maintenance`
- sourceRef: `workmate_plan_drift`

### intent 形状

- **Problem**：drift 报告对"计划目录"给出假阳性 missing；对"声明了没改"给不出任何信号。
- **Proposed outcome**：`computeDrift` 接受 `ignoredPrefixes`，落在其中的声明归入新的
  `excluded` 字段而**不**计入 `missing`；`plan-drift` 步骤在有未触及声明时产出 `warn`
  step（新增状态），既有的 `undeclared → failed` 语义不变。
- **Affected users and systems**：`workmate_plan_drift` 的返回体（新增 `excluded`）；
  归档编排的 step 状态联合类型（新增 `warn`）；面板/工具读 `steps` 的地方
  （只按 `failed` 判定，`warn` 不影响）。
- **Constraints**：不新增"声明必须被触及"的阻断语义（会冤杀正当的路径调整）；
  不改 store 形状；`warn` 不是失败，任何以 `ok === false` 判定的消费方行为不变。
- **Open questions**：是否该给 `excluded` 也加一条计数提示？本变更选**不加**——
  "计划文件在自己的计划目录里"是常态，为常态发提示就是噪音。

## What Changes

- `src/features/proposal/artifacts.ts`：`DriftReport` 新增 `excluded: string[]`；
  新增 `DriftOptions.ignoredPrefixes`；`computeDrift(declared, actual, options?)`。
- `src/features/archive/orchestrate.ts`：`collectProjectDrift` 把计划目录前缀作为
  `ignoredPrefixes` 传入；`plan-drift` 步骤在有 `missing` 时产出 `status: 'warn'`
  并列出未触及的声明；`StepResult.status` 联合类型新增 `'warn'`。
- `src/features/archive/drift.test.ts` + `src/features/proposal/artifacts.test.ts`：
  新增 4 条用例（warn 步骤不阻断、计划目录不算 missing、前缀相等也算 excluded、excluded 不计入 missing）。
- `AGENTS.md` 归档门禁表：写明 `planDriftGate` 只拦"改了没声明"，"声明了没改"是 `warn`。

## Impact

- 兼容性：`excluded` 是新增字段；`warn` 是新增状态值。既有消费者只在 `status === 'failed'`
  上分支（`service.ts:477`），因此行为不变。旧数据的 drift 报告里不会有 `excluded`，
  读取方若做严格结构断言会受影响（本仓库无此类断言）。
- 影响文件：`src/features/proposal/artifacts.ts`、`src/features/archive/orchestrate.ts`、
  `src/features/archive/drift.test.ts`、`src/features/proposal/artifacts.test.ts`、`AGENTS.md`。
- 范围外：不阻断 missing；不做"声明覆盖率"评分；不解析示例注释的语义。
