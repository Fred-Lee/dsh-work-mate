# Design — Add Decision Layer

## D1 用强制工具调用换类型化答案

`ctx.llm.stream({ provider, model, messages, system, tools })` 支持一次调用只暴露一个
工具、其参数 schema 就是选项枚举；模型的答案落在 `tool-call-delta` 的
`argumentsDelta`（拼起来是 JSON）。这就是"类型化题目"：**没有自由文本可解析**，
解析失败即视为答不出（→ 降级），而不是猜。

## D2 certainty 从哪来

Jev 给的是校准概率；LLM 没有。所以 `agent` provider 用**多采样一致率**当 certainty
代理：`samples: n`（默认 1，重要节点可配 3），取多数选项，certainty = 多数票占比。
n=1 时 certainty = 1（单票全信）——这一点必须在留痕里能看出来（记 `samples`），
否则会把"一次采样"误读成"高置信"。

## D3 阈值归我们，动作只有三种

`act` / `review` / `abstain` 由 `Config.decision.thresholds { act, review }` 计算：
`≥ act → act`、`≥ review → review`、否则 `abstain`。这与 TypeSafe 自己的纪律一致
（"`decision` is computed by this server in code — never Jev's own opinion"）。

## D4 只能收紧，不能放松

判断层是**附加门**：它可以把一次操作标成需要复核（`review`）或拒绝，永远不能把确定性
门禁本来会拦的操作放行。实现上，"放行"的判定仍由既有门禁代码负责，判断层只提供
`review`/`abstain` 信号。对 `decide` 工具而言：`act + contradicts` → 拒绝（要求
`supersedes`）；其它结论一律照旧，不改变原有行为。

## D5 降级链与可见性

provider 顺序 `agent → rules`（可配 `provider` 固定其中一种）。任一环节
不可用/超时/答不出都继续下一环；全部失败 → `abstain`（不是 `act`）。
事件里记 `provider`、`degraded`、`reason`，让"这次判断其实没跑成"在账本上看得见。
