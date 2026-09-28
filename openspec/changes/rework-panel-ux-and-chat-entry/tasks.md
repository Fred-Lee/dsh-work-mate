# Tasks — Rework Panel UX and Chat Entry

- [x] 1. host 半：`POST /api/proposals` 的 id 可选（缺省 `proposal-<base36>`）+ 测试
- [x] 2. 面板重做：三列看板（状态色条/进度条/悬停抬升）、卡片展开详情、
      ＋新提案模态、dsw 主题令牌 + prefers-color-scheme 双层变量
- [x] 3. 对话入口：`ChatProposalAction` 同时挂 `conversation.chat.assistant-actions`
      与 `conversation.input.left`（Codingns4DSH 快捷短语位），slots 走
      `ctx.inject` 局部作用域
- [x] 4. 测试更新：看板列布局 / 模态创建 / 卡片展开 / 对话入口全链路（57 用例）
- [x] 5. build / typecheck / contract 全绿，真机重启面板与 client.js 验收
