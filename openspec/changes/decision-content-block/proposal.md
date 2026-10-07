# Decision Message Content Blocks

## Why

把诊断一路追到宿主适配器后，拿到了**最后一个真实报错**（54 条一致）：

```
provider=deepseek-official model=deepseek-v4-pro
finishFailure={"message":"content.some is not a function","code":"UNKNOWN"}
```

即：路由已经对了（`deepseek-v4-pro` 有效）、调用也发出去了，但**宿主的请求装配/适配器会对
`message.content` 调 `.some()`**——它期望**内容块数组**，而我传的是裸字符串。

## What Changes

1. `messages[].content` 改为块数组 `[{ type: 'text', text: ... }]`（宿主 `TextBlock` 形态）；
2. 本地 `HostLlmFace` 类型同步放宽（`content: string | TextBlock[]`）；
3. 新增用例断言发送的是数组且首块为 `type: 'text'`（防止回归成裸字符串）。

## Impact

- `src/features/decision/agent.ts` + 1 个用例；判断语义与阈值不变。
- 这是"判断层能否真正工作"的最后一个已知阻塞点。
