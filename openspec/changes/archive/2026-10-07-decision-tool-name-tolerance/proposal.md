# Tool-Name Tolerance + Chunk-Type Diagnostics

## Why

路由回退修好后（不再落到 `deepseek-account`），重排诊断变成：

```json
{"provider":"deepseek-vision","chunksSeen":204,"textChars":0,
 "failure":"no tool-call emitted (model answered in text?)"}
```

**204 个块、零文本、也没有 `answer` 工具调用**——两种可能无法区分：模型用了**别的工具名**（我的循环按名字过滤，直接把增量丢了），
或者它只吐了推理块。前者会让"模型其实答了"被误判成"模型没答"。

## What Changes

1. 按**工具名分桶**收集参数增量：优先 `answer`，其次任意工具调用；只要参数能通过选项枚举校验就采信
   （真正的契约是参数 schema 与枚举，不是工具名）。
2. `reasoning-delta` 计入内容长度（不再表现为"零文本"）。
3. 诊断新增 `chunkTypes`（块类型直方图）与 `toolNames`（实际出现的工具名）。

## Impact

- `src/features/decision/agent.ts` + 2 个用例；枚举校验与阈值语义不变。
- 下一个判断节点若再失败，诊断将直接给出"模型用了什么工具名/吐了哪些块类型"。
