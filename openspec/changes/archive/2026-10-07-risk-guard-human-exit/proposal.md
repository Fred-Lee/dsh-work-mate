# Say What To Do When the Risk Judgement Stays at `review`

## Why

真机验收时触发了我上一轮加的守卫（**这正是它该做的**）：

```
推进到 implementing 前必须先判定风险：调用 workmate_assess_risk
```

但接着调用 `workmate_assess_risk` 返回：

```json
{"risk": null, "judgement": {"node":"risk-tier","action":"review","choice":"high",
 "certainty":0.666...,"threshold":0.6,"provider":"agent","samples":3}}
```

即：模型 2/3 采样判 **high**，置信 0.67 → 动作是 `review`，而按设计 **D2「只有 act 档结论才成为事实」**
工具**不写入** `risk` → 守卫永远无法被 agent 满足 → **agent 流程卡死**（人类仍可点，但错误信息没说这一点）。

## What Changes

守卫的错误文案补齐两个信息：① 判断层只给 `review` 档时工具不会写入风险（设计如此）；
② **该守卫只约束 agent，人类在面板点「推进到 X」即可通过**。

## Impact

- `src/features/archive/service.ts`（文案）+ 用例断言"人类不受此守卫限制"。
- **不改 D2**：仍然只有 `act` 档结论才会被写进 `risk`；只是把出路说清楚。
