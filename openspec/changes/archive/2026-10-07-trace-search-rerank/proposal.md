# Trace the Search Rerank Judgement

## Why

重排上线后真机核对：`note` 里**没有**"已用模型重排"字样，事件流里也**没有** `search-rerank` 记录 →
**无法判断**模型是"选了原本第一位的候选（因此无变化）"还是"根本没被调用"。这正是 `module-match`
当初踩过的坑：**判断没有留痕就等于不可观测**。

## What Changes

1. `rerankHits` 每次调用都写一条 `decision` 事件（`proposalId: _wiki_search`，含
   `action` / `choice` / `certainty` / `provider` / `threshold` / `cached`，detail 记录查询与候选数）；
2. 弃权/失败同样留痕（`action=abstain`，`provider=none`）。

## Impact

- `src/index.ts` 一处；行为不变，只增加可观测性。
