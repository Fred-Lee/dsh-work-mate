# Design — Add Decision Nodes

## D1 判断层的注入方式

`orchestrate.ts` 与 `api.ts` 都不直接依赖 `DecisionService`：它们各自的 deps 增加一个
可选回调（`decide?: (question, signal) => Promise<DecisionOutcome | undefined>`）。
`index.ts` 在装配处注入 `(q, s) => decision.decide(q, s)`。好处：判断层仍然只在入口处
构造一次，使用者拿到的只是一个可空函数，"没启用 = undefined = 行为不变"是类型层面的。

## D2 采信门槛：只有 `act` 才改变事实

四个节点都遵循同一条：`action === 'act'` 才把结论写进领域事实（risk 字段、findings、
untrusted、taskJudgements）；`review` 只在摘要里提示，`abstain` 等于没发生。
理由：`review` 的语义是"需要人看"，把它自动写成事实就是把待复核当结论。

## D3 成本上限写在代码里

审查分级每次最多 5 条、任务判定最多 3 条——判断层调用是模型调用，不能随 diff 线性膨胀。
上限可配（`reviewGradeMax`），但默认值刻意小：宁可漏判，不可让归档变成几十次模型调用。

## D4 风险分级与人工批准门叠加

`risk: high` 不替换 `approvalsRequired`，而是**并集**：`gated(to) = approvalsRequired ∪
(risk === 'high' ? highRiskExtraGates : ∅)`。这样"高风险更严"是叠加语义，不会因为配了
风险门就松开默认的 merging/archiving 门。

## D5 任务判定默认只记录

"diff 是否满足这条任务"是判断题，误判代价是**卡住归档**。所以默认只写进 manifest
（`taskJudgements`），要阻断得显式 `taskJudgementGate: true`。这与漂移门（`planDriftGate`
默认 false）同一取舍：新引入的语义门先观察，再收紧。
