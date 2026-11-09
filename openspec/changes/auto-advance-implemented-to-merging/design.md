# 设计：实现完成时自动推进到 merging（低频调度器版）

## D1 读路径绝对不写

事故的直接原因：`board()` 被当作"只读视图"，却在里面发起了 `transition`。而
`board()` 有三个调用者（`/api/tasks`、`leftover()`、`reclaim()`），前两个面板会同时请求。

**纪律**：`board()` / `leftover()` / `reclaim()` SHALL 保持只读（除了 `board()` 已有的
`cacheObservedTickets` 这类幂等缓存写，且它不触碰提案聚合）。任何"因为观察到 X 就去改 Y"
的动作，都属于调度器职责。

## D2 独立调度器，单飞 + 低频

新增 `AdvanceScan`：`setInterval(tick, intervalMs)`，默认 60 秒。

- **单飞**：`running` 标志，上一轮未结束就跳过本轮（不排队、不累积）。这是防止
  事故里那种"越积越多"的关键。
- **低频**：60 秒对本场景足够（worker 完成到人看到「待合并」延迟一分钟可接受），
  且与面板 5 秒轮询完全解耦。
- **可停**：随插件 `ctx.effect` dispose 一起 `clearInterval`。

## D3 持久化"已推进"标记

提案记录新增 `autoAdvancedAt?: string`：

- 推进成功时写入（连同事件流的 `actor: 'system'` 记录）；
- 扫描时跳过已有 `autoAdvancedAt` 的提案——**即使它因为别的原因又回到 implementing**
  （人回退），也不再自动推进，避免与人手动操作打架；
- 重启后标记仍在，不会重复扫描同一提案。

## D4 判据（沿用上次正确的部分）

纯函数，不依赖时序：

- 该提案**至少一条**待办（无待办不推进，避免空提案被自动放行）；
- 全部待办在 `done` 列；
- 终态为 `completed` / `merged` / `dropped`；
- 终态 `closed` / `stopped` 不算完成。

## D5 失败隔离与可观测

- 单个提案 `transition` 抛错（Wiki 未登记、基线缺失）→ 记事件 `gate-failed`，
  不写 `autoAdvancedAt`（下次扫描会重试），继续处理下一个提案；
- 扫描结果写一条 `advance-scan` 事件（扫描了多少、推进了哪些、受阻原因），
  便于事后回答"它为什么动了 / 为什么没动"。

## D6 与 G5 的边界

`implementing → merging` 不是人工门（G5 是 `merging → archiving`）。自动推进只把
"实现做完了"这件事落到状态上，合并与归档仍由人决定。

## D7 验收必须覆盖事故场景

单测/集成用例必须包含：

1. 连续 50 次并发 `board()` 调用 + 扫描交错 → 无死锁、无重复推进；
2. 同一提案被扫描两次 → 只推进一次（`autoAdvancedAt` 生效）；
3. 推进中途某个提案抛错 → 其余提案仍被处理；
4. 扫描与 `board()` 同时执行时，`board()` 的返回在合理时间内完成（用超时断言）。
