# Tasks — 面板门禁文案与看板语义澄清

- [x] 1. 规格增量：`workbench-panel` 补"看板列与状态标签的对照 SHALL 可查、G2 与 G5
  的理由收集 SHALL 区分表述" <!-- writes: openspec/changes/clarify-panel-gates/specs/** -->
- [x] 2. `README.md`：收窄「面板会问批准理由」到 G5，补 G2 不收理由的说明；新增八态
  ↔ 五列对照表 <!-- writes: README.md -->
- [x] 3. `src/client/App.tsx`：`proposing` 标签改「提案分支已建」；看板列头补 title
  说明覆盖哪些状态 <!-- writes: src/client/App.tsx -->
- [x] 4. 用例：看板列归属快照（reviewing 必在「待确认」、merging/archiving 在「待合并」）
  <!-- writes: src/client/app.test.tsx -->
- [x] 5. 门禁全绿 + 真机截图复验后归档
  <!-- writes: （无源码写域；仅运行命令与记录） -->
