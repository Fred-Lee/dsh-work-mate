# Review — 决策缓存命中必须过形状校验

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认：活路径（`parseAnswer`）已把枚举外选择判为无结论，缓存路径补齐后
  两条路径的信任边界一致。
- [x] 确认：`cacheKey` 含 node + state + route，options 由 node 决定，正常写入的
  条目不会被本变更误判失效。

## 疑问项

- 无。

## 建议补充项

- 后续若要防"同一 state 在不同 options 集下复用缓存"，可在缓存值里记 options
  摘要并在命中时比对（本变更不做，当前 node→options 映射是静态的）。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] 无未解决 CRITICAL 问题。
