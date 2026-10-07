# Judgement Output Budget

## Why

把重排失败追到块类型层面后，结论一目了然（真机三次采样完全一致）：

```json
{"provider":"deepseek-vision","chunksSeen":204,"textChars":660,
 "chunkTypes":{"block-start":1,"reasoning-delta":200,"block-end":1,"usage":1,"finish":1},
 "toolNames":[],"finishKind":"max-tokens"}
```

即：**200 个推理块把 200 token 的输出预算吃光**（`finish: max-tokens`），模型根本没能发出工具调用。
此前的 `maxTokens: 200` 对推理型模型是**结构性不足**——这也很可能解释了几个归类迭代的留白。

## What Changes

1. `AgentProviderOptions.maxTokens` + `Config.decisionMaxTokens`（默认 1024；本机 1500）；
2. 请求里用配置值（保留 `temperature: 0`）；
3. 判断超时本机 8s → 20s（推理 + 工具调用在 8s 内经常来不及，真机 `risk-tier` 实测 16.5s）。

## Impact

- `src/features/decision/agent.ts`、`src/config.ts`、`src/index.ts` + profile。
- 判断语义、阈值与 `act` 采信纪律不变；仅给推理留出预算。
