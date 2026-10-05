## ADDED Requirements

### Requirement: 看板化提案视图

提案视图 SHALL 呈现为三列看板（提案中 / 执行中 / 已归档），列头展示计数，卡片
SHALL 按状态落列并展示标题、id 与 OpenSpec 进度；点击卡片 SHALL 展开详情
（Git 关联提交、openspec 状态、推进/归档动作）。创建 SHALL 经「＋ 新提案」模态；
整套样式 SHALL 用 CSS 变量实现深色自适应（`prefers-color-scheme`）。

#### Scenario: 状态一眼可读

- **WHEN** 存在不同状态的提案打开面板
- **THEN** 三列并列、每列计数正确、卡片落在对应列且带状态色条与进度条

#### Scenario: 深色环境可读

- **WHEN** 系统（或宿主外壳）处于深色模式
- **THEN** 面板使用深色变量渲染，无白底刺眼或文字不可读

### Requirement: 对话动作行「转为提案」入口

client half SHALL 在 `conversation.chat.assistant-actions`（session 作用域 slot）
注册「🚀 转为提案」动作：点击弹出小表单（标题必填、项目根可选），提交经
`POST /workmate/api/proposals` 创建（id 缺省自动生成），成功后 SHALL 提供
「打开面板」直达链接；slot 注册 SHALL 保持 `ctx.inject(['slots'], …)` 局部作用域，
`slots` 服务缺席时 client half 其余部分 SHALL 不受影响。

#### Scenario: 头脑风暴后一键转入开发流程

- **WHEN** 用户在 AI 回复的动作行点击「🚀 转为提案」并填写标题提交
- **THEN** 提案创建成功，点击「打开面板」直达 WorkMate 看板并能看到新提案

#### Scenario: slots 缺席不拖垮界面

- **WHEN** 宿主 client 环境没有 slots 注册表
- **THEN** better-sidebar tab 仍然注册成功，仅对话动作行入口缺席
