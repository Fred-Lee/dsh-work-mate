# Decision Finish Kinds

## Why

真机诊断（54 条，全部 `node=module-match`、`provider=deepseek-official/model=deepseek-flash`）显示
失败原因是 `finish:[object Object]`——因为宿主的 `FinishReason` 是**对象**：

```ts
export type FinishReason =
  | { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure } | { kind: 'error'; failure: LlmFailure }
```

我此前用 `String(reason)` 比较字符串，于是：(1) **正常结束也被误判为失败**；(2) 真正的
`failure` 载荷（适配器报错原文）被丢掉，只剩 `[object Object]`，诊断等于没诊断。

## What Changes

1. 按 `reason.kind` 判定终态：`stop` / `tool-calls` / `max-tokens` 为正常；`aborted` / `error` 判失败；
2. 失败时保留 **`finishFailure` 原文**（适配器给的结构化错误），并保证诊断行可序列化（防 BigInt/循环）；
3. 测试：工具调用在 `finish:tool-calls` 前到达 → 正常返回 choice；`finish:error` → 无结论且不抛错。

## Impact

- `src/features/decision/agent.ts` 与测试；判断语义不变。
- 下一轮即可从诊断文件读到**适配器真实报错**，据此修调用本身。
