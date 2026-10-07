# LLM Rerank for Vault Search

## Why

本地 bge-m3 的**召回**可用，但**排序**对短中文查询仍不理想（实测头部会被"触及的模块"这类低信息量分块占据）。
判断层现已真机可用（`provider=agent`，三个节点实证），因此可以用它做**重排**：余弦只负责给出候选集，
模型在候选里挑最相关的一个。

## What Changes

1. `semantic.ts` 新增可选重排钩子 `rerank`，并抽出纯函数 `applyRerank(hits, best)`：
   把模型选的候选移到首位并注明"首选原第 N 位"；**越界/缺省/abstain 一律保持召回顺序**
   —— 重排绝不能丢结果或凭空造结果。
2. 新判断节点 `search-rerank`（选项 = 候选序号 + `none`，只采信 `act`；每次最多 8 个候选）。
3. 配置 `wikiVaultRerank`（默认 false，本机开启）；工具/命令/REST 三条检索入口统一接入。

## Impact

- `src/features/wiki/semantic.ts`、`decision/types.ts`、`config.ts`、`index.ts` + 用例。
- 判断层关闭或重排失败时行为与之前完全一致（纯余弦顺序）。
