# Add Decision Cache (Jev-like economics for the agent judge)

## Why

判断层的 `agent` provider 每次判断都是一次真实模型调用。用 DeepSeek 模拟 Jev 的最大差距
不在"能不能答"，而在**单位成本与延迟**：Jev 的卖点是几百毫秒、几分钱，而模型调用是秒级。
好在判断节点的题目**高度重复**——同一段 state + 同一组选项（同一条审查发现的归级、
同一份 diff 的任务判定、同一条决策的矛盾检测）会被反复问到，尤其是归档重试、面板刷新、
`workmate_bands` 之类的重复触发。

所以补一层**判断缓存**：同题同参直接复用上次结论，把重复判断的边际成本压到零。
这不改变判断语义（缓存键包含 state、选项与 provider/model），只消除重复计算。

## What Changes

1. **缓存**（`src/features/decision/cache.ts`）：`$DSH_HOME/<workmateHome>/decision-cache.json`，
   键 = `sha256(node | state | question | options | provider | model | samples)`，
   值 = `{choice, certainty, samples, provider, model, at}`。
   - **原子写**（tmp + rename），条目上限 `Config.decisionCacheMax`（默认 500），按 `at` 淘汰；
   - **fail-open**：文件损坏/不可写只记警告并继续判断——缓存坏掉绝不能挡住门禁。
2. **只缓存模型答案**：`rules` 是确定性函数，缓存它没有意义；键里带 `provider/model`，
   换模型即换缓存。
3. **可见性**：`DecisionOutcome.cached` 与 `decision` 事件的 `cached` 字段；
   命中时 `latencyMs` 接近 0——"这次判断是复用还是真跑了"一眼可辨。
4. **开关**：`Config.decisionCacheEnabled`（默认 true）。

## Capabilities

### 新增能力

- `decision-cache`：判断结果缓存（原子写、有上限、fail-open、命中可辨）。

## Impact

- 新增 `src/features/decision/cache.ts` 与测试；`service.ts` 接入缓存；
  `events.ts` 加 `cached`；`config.ts` 加 `decisionCacheEnabled` / `decisionCacheMax`。
- **默认行为**：缓存默认开启，但只在判断层启用时被走到——判断层关闭时一切照旧。
