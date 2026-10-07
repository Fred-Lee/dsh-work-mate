# Decision Call Diagnostics

## Why

真机数据显示路由**已经解析成功**（`model: "deepseek-flash"`、`listedProviders: 5`、`listedModels: 0`），
但 `llmAsked=18 / llmMatched=0` 且 `decision-cache.json` 从未生成——说明调用**发出后没有得到工具调用**。

读宿主类型得到根因：`llm.stream()` 是**适配器原始协议**，适配器失败会被宿主**归一化成终态
`finish` 块**（`reason: error|aborted`），**不抛异常**。而 agent provider 只认 `tool-call-delta`、
完全忽略 `finish` → 调用失败与"模型没答"在代码里**长得一模一样**，于是静默返回 undefined。

> 顺带纠正：此前怀疑的"路由需要非空 model"只对了一半——`decisionModel` 确实必须配（已配），
> 但配好之后仍失败，真正的盲点是**忽略终态 finish 块**。

## What Changes

1. `agent.ts` 采样循环改为理解宿主协议：记录 `finish.reason`、累计文本字符数、捕获异常；
2. 失败原因追加写入 `<DSH home>/workmate/decision-diagnostics.jsonl`（fail-open，绝不影响判断）；
3. 契约：`finish` 不属于正常终态（`stop`/`tool-calls`/`end_turn`）即记为失败；无 `tool-call-delta` 时
   记录"模型用文本回答"这一事实，而不是无声返回 undefined。

## Impact

- `src/features/decision/agent.ts` 单文件 + 新诊断文件；判断语义不变（仍只认工具调用里的枚举答案）。
- 诊断文件是**临时取证件**，用于确认判断层是否真的可用。
