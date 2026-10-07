# Diagnostics Precision + CLAUDE.md De-copy

## Why

两件收尾工作，都源自实测暴露的问题：

1. **重排节点拿不到答案**：真机 `search-rerank` 事件是 `action=abstain provider=none`，
   诊断文件里同一批记录全写着 `no tool-call emitted (model answered in text?)` 且 `textChars=0`。
   但"模型用文本回答"与"**流里一个块都没有**"是两种完全不同的故障，现有文案把它们混为一谈。
2. **`CLAUDE.md` 滞后**：它是 `AGENTS.md` 的历史副本（实测差 140 行），会持续漂移。

## What Changes

1. 诊断新增 `chunksSeen`，并把无工具调用的失败细分为
   `empty stream (no chunk at all)` 与 `no tool-call emitted (model answered in text?)`
   —— 下一次调试可直接区分"适配器没吐块"与"模型改用文本"。
2. `CLAUDE.md` 改为**指向 AGENTS.md 的薄壳**（保留三条最易踩纪律），彻底消除副本漂移。

## Impact

- `src/features/decision/agent.ts`（诊断字段）、`CLAUDE.md`（文档）。
- 行为零变化：仅诊断精度与文档维护性。
