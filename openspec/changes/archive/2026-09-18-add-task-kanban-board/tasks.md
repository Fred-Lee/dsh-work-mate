## 1. `@helmsman/ui-board` 宿主骨架

- [x] 1.1 搭建 `packages/ui-board`(host+client,结构复制 ui-dashboard):webServer 注册 `mountPath`(默认 `/helmsman-board`),`createApiRouter` 工厂 + 静态 SPA handler
- [x] 1.2 服务接线:`inject:['webServer','helmsman.board']`;`orchestrator`/`artifacts` 可选懒取;REST 路由仅做只读/受控转发(board 接口 + 供详情用的 run/artifact 读取)
- [x] 1.3 导出可嵌入 `BoardView`(SPA 同组件),供未来抽屉复用

## 2. 看板主视图

- [x] 2.1 四列布局(横向滚动):需求分析/规格设计/开发实施/验收归档;列头计数;第 ③ 列显示 `在跑/上限`
- [x] 2.2 卡片组件:标题 + 摘要(≤4 行截断)+ 角标(📄/💬/🧩)+ run 状态点(在跑/排队/已合并/完成);`queueingReason` 卡片置灰
- [x] 2.3 筛选(仓库/阶段/含-无对话)与 URL query 同步(`?repo=&stage=&card=`);刷新/分享不丢状态
- [x] 2.4 组件测试:列渲染/筛选/排队灰卡/URL 还原(jsdom + @testing-library,按 ui-dashboard 现有 client 测试约定)

## 3. 卡片详情与关联跳转

- [x] 3.1 右侧详情抽屉:阶段、摘要(可编辑→board setSummary)、推进门清单、关联分区(文档/对话/服务/worktree/runs/产物)可展开收起
- [x] 3.2 关联解析与跳转:文档→draft/Tolaria 打开、run 冲突→`/helmsman-diff`、产物→下载端点;悬空关联显示徽标
- [x] 3.3 Router 单测:详情查询、关联跳转所需元数据、悬空引用 404 语义

## 4. 推进交互与 WIP

- [x] 4.1 HTML5 原生拖拽:放到目标列 → 调 board 推进(默认单步);缺口弹窗列出 `GateGap` 与"补齐跳转"入口;WIP 拒绝保持原位并提示 `queueingReason`
- [x] 4.2 "推进到下一阶段"按钮(非拖拽路径同样走推进接口);成功后列即时更新;进 dev 时编辑 `scope.module`(候选 auto-suggest 可改)
- [x] 4.3 第 ③ 列按冲突域标签分组,显示各域 `在跑/上限`;组件测试:拖拽→推进接口调用(不本地移动)、缺口弹窗、同仓不同模块并行呈现、同域超限排队文案

## 5. run 实时面板与建档入口

- [x] 5.1 卡片 run 展开区:run 列表(引用 board + orchestrator 读取);复制 ~60 行 EventSource helper(指向 dashboard SSE,注释指向源,可配置 mount 基址),SSE 实时 timeline + 断线重连续传
- [x] 5.2 冲突标注行只跳转 `/helmsman-diff`;看板内不提供自动合并/自动裁决控件;审批挂起显示"待审批令牌"提示(消费 change C 呈现面);已 merge run 提供"确认影响服务"(候选 → board associate)
- [x] 5.3 页面内"+ 新建任务"表单(仓库/项目组/初始阶段/可选文档预设)→ board create + 摘要生成
- [x] 5.4 "保存为任务"client half:注册聊天消息动作,把当前 DSH 会话 id/上下文带入建档弹窗(复用 ui-workbench 注入方式);无会话上下文时隐藏该入口 —— 落在 `ui-workbench/src/client/`(`SaveAsTaskAction.tsx` / `save-as-task.ts`),注册到宿主的 `conversation.chat.assistant-actions` slot;31 个单测/组件测试 + 真机确认 client 半已执行。**浏览器点击穿透待补**(见 `VERIFICATION-GUIDE.md` §6.9)
- [x] 5.5 Router/组件测试:建档表单校验、会话入口上下文注入、SSE 驱动 run 行更新(假 EventSource)
- [x] 5.6 组件测试:run 冲突行仅渲染"跳转对比"入口,页面树中不存在自动合并/一键采纳控件(防止回归成系统代选)

## 6. 集成与文档

- [x] 6.1 全仓 `pnpm typecheck` 与 `pnpm exec vitest run packages/ui-board` 通过
- [x] 6.2 真实 profile 冒烟(手动,记录 commit message):建档→推进→dev 跑 run→merge→归档 全链路;SSE 断线续传;拖拽门拦截 —— 实测见 `VERIFICATION-GUIDE.md` §6.1–6.8。全链路**跑通到归档成功**(`gate ok=True gaps=[]`),为此补了 `GateProbe` 宿主接线(`ui-board/src/gate-probe.ts` + `board.setGateProbe`)。SSE 游标续传实测通过;**拖拽门拦截**在接口层验证(拒绝且卡片不移动),浏览器拖拽未取证
- [x] 6.3 并入 bundle:更新 `packages/bundle` 13→15(+board/ui-board),README 交付物表、`toolchain.json` `helmsman.plugins`、`docs/DISTRIBUTION.md` 计数一致;更新 `docs/USAGE.md`、`docs/ARCHITECTURE.md`

## 7. 说明（父对话记录）

- [x] 7.1 聊天消息侧"保存为任务"入口(5.4)未实现:当前建档入口为看板页「+ 新建任务」表单 + 宿主 REST `POST api/task-from-conversation`(可直接调用)。聊天消息动作属 DSH client slot 增强,留待后续