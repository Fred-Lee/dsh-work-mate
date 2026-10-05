# Rework Panel UX and Chat Entry

## Why

真机演示后的两条产品反馈：
1. 面板「不好看、不直观」——当前是单列卡片流 + 小徽章，开发流程（提案→执行→归档）
   的推进感没有可视化。
2. 缺少「对话场景 → WorkMate 场景」的切换入口——头脑风暴聊完之后，用户应该能在
   AI 回复的动作行上一键把讨论转成提案并进入开发流程，而不是跑到独立页面手工建。

## What Changes

1. **看板化重做**：提案视图改为三列看板（提案中 / 执行中 / 已归档），卡片带状态
   色条与 OpenSpec 进度条，点击展开详情（Git 关联 / 归档与推进动作）；创建表单收进
   右上「＋ 新提案」模态；全套 CSS 变量 + `prefers-color-scheme` 深色自适应。
2. **对话入口**（真机 slot 模式，Helmsman「保存为任务」同款）：在
   `conversation.chat.assistant-actions` 注册「🚀 转为提案」——头脑风暴的 AI 回复
   下方点一下，弹小表单（标题 + 可选项目根），创建成功后一键打开 WorkMate 面板。
   `slots` 保持 `ctx.inject` 局部作用域注册（缺席时不拖垮 client half）。
3. **REST 微调**：`POST /api/proposals` 的 `id` 变为可选——缺省自动生成
   `proposal-<base36 时间戳>`，对话入口的弹层因此只需填标题。

## Capabilities

### 修改能力

- `proposal-middleware`：REST 的 id 可选化；面板从单列列表改为看板布局并新增
  对话动作行入口（ADDED requirements）。

## Impact

- `src/client/`：App.tsx 拆分 BoardView / CreateModal，新增 ChatProposalAction；
  styles.ts 重写为 CSS 变量体系。`src/index.ts`（client）注册 assistant-actions。
- Host 半仅 createProposal 的 id 归一化一处；无新依赖。
