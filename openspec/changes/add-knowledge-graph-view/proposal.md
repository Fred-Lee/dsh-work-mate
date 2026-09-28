# Add Knowledge Graph View

## Why

里程碑五（可选）：右侧面板展示「需求 ↔ 项目 ↔ Git 提交」关系图（设计文档 §3.2.3、
§7 里程碑五），让提案的知识沉淀一目了然。

## What Changes

1. **GraphView 组件**：`/workmate/api/graph`（M2 已落）为数据源，SVG 分层布局
   （提案列 / 项目列 / 提交列，边带关系标签）。
2. **面板集成**：提案面板顶部加「提案 | 知识图谱」视图切换，projectRoot 输入共享。
3. **技术选型修正**（design D1）：设计文档的 `@antv/g6` / `cytoscape.js` 都是
   MB 级依赖，仅为可选里程碑引入不值；本仓模板可用的分层图用约百行自绘 SVG
   等价满足「3 层关联」验收。复杂力导向需求出现时再评估引库。

## Capabilities

### 新增能力

- `knowledge-graph-view`：图谱数据到 SVG 分层视图的渲染契约。

## Impact

- 仅 client 半新增 GraphView 与视图切换；REST 数据面 M2 已交付；零新增依赖。
