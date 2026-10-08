# Tasks

> 范围声明用行内 `<!-- writes: … -->`（swarm 装批 + `workmate_plan_drift` 都读它）。
> 本变更**不写** `.claude/**`、不改服务端、不新增运行时依赖。

- [x] 1. 样式契约：`.wm-root` 加 `display:flex; flex-direction:column; height:100%; min-height:0`，把 `padding: 0 0 24px` 从 `.wm-root` 移到新层 `.wm-body`；新增 `.wm-body { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding-bottom:24px }` <!-- writes: src/client/styles.ts -->
- [x] 2. 结构：`App.tsx` 把三视图（`GraphView` / `ConsoleView` / `.wm-board`）包进 `<div className="wm-body">`，页头与错误条留在 `.wm-root` 直接子级 <!-- writes: src/client/App.tsx -->
- [x] 3. 规格增量：新增「面板根节点高度契约与滚动」要求 + 三个场景（超长可滚到底 / 页头保持可见 / 独立页不被破坏） <!-- writes: openspec/changes/fix-panel-scroll/specs/workbench-panel/** -->
- [x] 4. 结构断言测试（jsdom）：`.wm-root > .wm-header` 与 `.wm-root > .wm-body`；`.wm-body` 内是 `.wm-board`；切到控制台/知识图谱时视图仍在 `.wm-body` 内；打开新建弹窗时页面**不出现** `.wm-body` <!-- writes: src/client/app.test.tsx -->
- [x] 5. CSS 契约测试：对 `PANEL_STYLE` 文本断言 `.wm-root` 含 `height:100%`、`.wm-body` 含 `overflow-y:auto` 与 `min-height:0`（防未来误删） <!-- writes: src/client/app.test.tsx -->
- [x] 6. 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify`（不以退出码判定，看产物：`dist/client/app.js` 与 `dist/client/client.js` 均被重建） <!-- 无仓库内写入 -->
- [x] 7. **真机验收（本变更的核心判据）**：`pnpm build` → 用户执行 `~/.dsh/harness-restart.sh` → 打开 WorkMate 面板并展开超长提案卡片，判定 C1–C7：卡片底部边框/圆角可见、面板右侧出现滚动条、页头仍在顶部、控制台与知识图谱可滚、`/workmate/` 独立页不塌陷。**实际取证**：(a) 用户在重启后的真机面板确认「可以滚动」，并点到了此前无法到达的「推进到 归档中」按钮（事件流 `2026-10-08T14:51:37.785Z` `merging→archiving`）——若仍不可滚，该按钮在视口外，此迁移不可能发生；(b) 以 CDP 在同一份代码上复刻宿主裁剪上下文，读到 C1/C2/C3/C4/C5/C6 的计算样式与滚动几何，并做**修复前语义对照**（对照态 `canScroll=false`、`scrollTop` 恒 0；修复态 `scrollTop` 实际到达 101px、页头 `top` 恒 0）；(c) 未取得 C1–C7 的完整截图组，故 C2/C7 的*视觉*判据弱于几何判据——已记入 `review.md` 的 `LOW-1`。 <!-- writes: openspec/changes/fix-panel-scroll/review.md -->
- [x] 8. 文档：把「面板根必须 height:100% + 唯一滚动子层」这条宿主契约写进 `AGENTS.md` 的插件契约段（否则下一个客户端面板会重踩） <!-- writes: AGENTS.md -->

## 验收命令（每步都跑，不以退出码判定）

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm verify
pnpm exec vitest run src/client/app.test.tsx
```

## 完成标记纪律

`[x]` 只表示"这一步被认为完成了"，不等于验收通过。第 7 项是**唯一**能证伪本修复的证据，
且必须由用户在重启后截图确认；第 4/5 项只防回归，不得当作"已修复"的证明。
