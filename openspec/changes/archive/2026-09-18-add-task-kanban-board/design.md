## 背景(Context)

change `add-task-workitem-model` 提供 WorkItem 聚合根(四阶段、DoR/DoD、关联集、`@helmsman/board` Service)。现有 Web UI 模式:`ui-dashboard`/`ui-workbench` 用 DSH `webServer` 注册前缀路由 + React SPA,客户端侧 ui-workbench 还演示了如何注入 DSH 会话上下文(`sessions`/`agents`)。本变更新增独立页 `/helmsman-board` 承载四列看板。run 实时数据来自 change A(SSE `/helmsman-dashboard/api/task/:id/stream` + 持久化事件),审批/审计来自 change C,产物下载来自 change D——本页全部只读消费这些既有端点/服务。

## 目标 / 非目标(Goals / Non-Goals)

**目标:**
- 独立 SPA `/helmsman-board`:四列卡片、摘要与角标、筛选、WIP(按仓库)与排队、卡片详情关联跳转、推进门交互、对话建档、run 实时面板。
- 全部状态写操作走 `@helmsman/board` 接口;破坏性动作(merge/discard/清理)仍经 change C 门控。
- 零新增运行时依赖;UI 模式复用 ui-dashboard(host+client、React、同 http 路由惯例)。

**非目标:**
- WorkItem 模型改动(只消费);多用户/权限;把看板塞进工作台抽屉(独立页,侧栏空间不足);新对话 transcript 解析器(见模型 change)。

## 决策(Decisions)

### D1. 新包 `@helmsman/ui-board`,挂 `/helmsman-board`
webServer host + React SPA(结构复制 ui-dashboard 的 `index.ts`/`http.ts`/`api.ts` 工厂模式),同时导出可嵌入 `BoardView`(未来可放进工作台/抽屉)。注入 `@helmsman/board`(必需)与 `helmsman.orchestrator`、`helmsman.artifacts`(可选,懒 `ctx.get`,缺失时对应分区降级)。
- **理由**:独立页需要横向四列+详情抽屉的宽画布;独立包避免把工作台进一步膨胀;可选依赖沿用既有 lazy 模式。
- **替代**:并进 ui-workbench(入口乱、耦合 drafts 专有逻辑);复用 better-sidebar Tab(宽度不足)。否决。

### D2. 四列横向滚动 + URL 状态
列布局默认单屏横向排布(1200px 以下横向滚动);筛选/展开卡片 id 写入 URL query(`?repo=&stage=&card=`)。
- **理由**:分享与刷新不丢状态;实现无状态路由负担。

### D3. 卡片与详情
卡片 = 标题 + 摘要(≤4 行截断)+ 角标(📄文档 💬对话 🧩服务) + run 状态点。点击开右抽屉:阶段、推进门、关联分区(展开/收起),关联点击经宿主解析跳转(文档→draft/Tolaria、diff→`/helmsman-diff`,产物→下载)。
- **理由**:卡片承载"聚合摘要快速浏览"(用户要求),详情承载完整关联;解析延迟到点击,避免首屏 IO。

### D4. 拖拽 = 推进接口,不做本地移动
HTML5 原生 DnD(零依赖)从源列放到目标列时,若目标列非相邻阶段则先执行多次单步推进或拒绝(默认单步,`allowSkip=false`);每步先显示门缺口;成功后列即时更新。WIP 拒绝时卡片留在原列并提示"排队"原因。
- **理由**:拖拽只是门控推进的可视化,绝不绕过 board 校验(D5 模型 change);相邻原则与单用户低风险场景匹配。

### D5. WIP = 冲突域呈现(策略在 board,UI 只管显示与排队)
WIP 评估在 board 服务层完成(change `task-workitem` D7:冲突域键 `repo:module`/`repo:*`,默认 `module:1`、整仓回退 2)。看板第 ③ 列按冲突域标签分组并显示 `在跑/上限`;卡片进 dev 时可编辑 `scope.module`(auto-suggest 来自 spec/关联文档/topology 候选);被拒卡片读取 `queueingReason` 置灰展示。
- **理由**:用户场景"同一仓库并行不同需求/模块"要求 repo 级一刀切不可取——冲突域把"无关模块并行、同模块竞争"区分开,才是看板要防的 merge 竞争;UI 不重复实现策略,只消费 board 返回的域计数与排队原因。

### D6. run 面板复用既有事件源,不重复实现
卡片 run 展开区直接消费 orchestrator 历史事件:列表走 board 注入的 run 引用 + `orchestrator.getEvents`(同包 read),实时走 SSE 端点(相对路径指向 dashboard mount,默认 `/helmsman-dashboard/api/task/:id/stream`,可配置)。EventSource 封装在 ui-dashboard 客户端已有实现——为避免跨插件运行时依赖,在 ui-board 复制一份 ~60 行同语义 helper(设计取舍,后续可抽共享)。
- **理由**:同源(同 loopback webServer),端点已由 change A 提供;重复小 helper 换取包间无运行时依赖。
- **替代**:把 SSE helper 抽成共享 npm 运行时包(跨插件运行时依赖,与现有"只 type-import"约定冲突)。否决。

### D7. 建档入口两处
(a) 页面内"+ 新建任务"表单(手选仓库/项目组、初始阶段、可选文档预设);(b) 聊天消息"保存为任务"→ 复用 ui-workbench 既有注入 `sessions` 的方式,提供 client half 注册消息动作,把当前会话 id/上下文带给弹窗;两处都经 board 创建并触发摘要生成(宿主 generator)。
- **理由**:DSH 会话上下文只在聊天页存在,必须靠 client half;页面表单作为无聊天上下文时的兜底。

### D8. 阶段名与视觉
列色/图标轻量区分四阶段(需求=灰、规格=蓝、开发=琥珀、归档=绿),与工作台抽屉 4 面板(研究/PRD/执行/知识)保持同一主题体系。

### D9. 冲突裁决与合并:干净合并自动,真实冲突才交给用户
合并语义按用户确认的规则定稿:**可干净应用的未冲突变更默认合并**(含多 agent 不重叠改动);冲突以"补丁实际应用失败(git 冲突)"为准,**如实**把该文件交给用户在 diff 界面逐文件裁决,裁决前不写入。看板内 run 面板对冲突只标注与跳转(`/helmsman-diff`),不提供自动裁决控件;任何"择优/最佳"表述指用户比较后选定。
- **理由**:现状 orchestrator 用"某文件被 >1 个 agent 改过"的文件级启发式标冲突(`markConflicts`),比"真实应用失败"更严,会造成不必要的裁决负担;按用户规则改为 apply-failure 判定,过度提示消除、真实冲突仍 100% 交给人。既有 ui-diff 的逐文件单选/手动编辑交互正好承载"真实冲突"的人工裁决。
- **开放问题/建议(待父对话拍板)**:改动冲突判定(文件级启发式 → apply-failure)会触及 orchestrator 合并/聚合逻辑与 ui-diff 标注,建议作为旧计划的一处小改独立 apply;并把"用户逐文件裁决结果随 merge 请求记录到 run 时间线 + 审计"一并纳入 change `add-approval-policy-and-audit-trail`(其本就改 merge 执行路径与审计写入),使"merge 经人裁决"可审计、可作为进入 `验收归档` 的证据。

## 风险 / 取舍(Risks / Trade-offs)

- [拖拽误操作导致多步推进] → 默认单步 + 缺口弹窗;提供"撤销上一步"(board 事件支持,若允许)留待后续。
- [dashboard mount 路径被改导致 SSE 断] → mount 路径做成 ui-board 配置项并在降级时回退轮询(粗 5s)。
- [跨包复制 EventSource helper 产生漂移] → 只读小工具,复制时加注释指向源;若出现第二处再抽共享。
- [SPA 体积] → 无新增 UI 库;产物走既有静态 handler。

## 迁移计划(Migration Plan)

新增包与路由,不改既有插件行为;先在无聊天上下文环境用页面内建档,再接入"保存为任务"client half。回滚 = 移除包与路由;board 数据(模型 change)保留。

## 开放问题(Open Questions)

- "保存为任务"按钮放消息级 hover 工具栏还是消息菜单里(取决于 ui-workbench/DSH 现有 client slot,apply 时探测 better-sidebar 或消息 action slot)。
