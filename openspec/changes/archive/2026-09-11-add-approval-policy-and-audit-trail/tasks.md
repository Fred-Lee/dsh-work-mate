## 1. 门控核心(框架无关)

- [x] 1.1 在 `packages/orchestrator/src/gate/gate.ts` 实现 `ConfirmationGate`:`request(op, scope)`、`decide(id, approve)`、`consume(op, scope, token)`,含一次性、作用域绑定、TTL(默认 300 s)语义;内存挂起/令牌存储
- [x] 1.2 在 `packages/orchestrator/src/gate/policy.ts` 实现策略加载:读 `~/.helmsman/policy.json`(感知 `HELMSMAN_HOME`),应用默认值(`merge/discard/worktree-cleanup/topology-delete: confirm-required`,`cancel: auto-grant`),校验未知键;`PolicyLike` 接口在测试中默认放行一切
- [x] 1.3 单测门控:放行/拒绝、令牌过期、令牌复用、错作用域令牌、cancel 自动放行、测试用 allow-all 策略

## 2. 审计日志

- [x] 2.1 在 `packages/orchestrator/src/audit/journal.ts` 实现 `AuditJournal`:追加式 JSONL 写 `~/.helmsman/audit/audit.jsonl`,fsync 后才返回;`recordDecision(...)`、`recordCompletion(...)`、`query({op,taskId,from,to})`
- [x] 2.2 单测日志:跨 store 重开的追加/读取往返、fsync 失败即中止(模拟不可写目录)、查询过滤、撕裂尾部容忍

## 3. 把门控 + 日志接入引擎与插件

- [x] 3.1 在 `packages/orchestrator/src/core.ts` 的 `OrchestratorCore.mergeTask/discardTask/cancelTask` 与 `worktree.removeTaskWorktrees` 调用路径上透传可选 `confirmationToken?` + 门控检查;副作用前记日志决定、副作用后记结果
- [x] 3.2 在 `packages/memory-topology` 服务边界给 topology 删除加门控依赖(或若删除由 orchestrator 编排,则在其中处理)
- [x] 3.3 扩展 `OrchestratorService`(类型 + `packages/orchestrator/src/index.ts`):`requestConfirmation`、`decideConfirmation`、`listPendingConfirmations`、`getAudit`;在插件 `apply()` 中构造 `ConfirmationGate` + `AuditJournal`
- [x] 3.4 经既有 `notify()` 汇聚点在任务终态追加 `run-completion` 审计条目

## 4. 工具对等

- [x] 4.1 在 `packages/orchestrator/src/index.ts` 的 `helmsman_merge_task`(两种 mode)与 `helmsman_cancel_task` 定义中加可选 `confirmationToken` 参数;处于 `confirm-required` 的操作在无令牌时以"门控拒绝 + 审批 id 指引"失败
- [x] 4.2 注册 `helmsman_request_confirmation` 与 `helmsman_decide_confirmation` 工具,与 REST 端点镜像
- [x] 4.3 核对会调用 merge 工具的 preset/工作流(检查 `packages/presets`、docs),为它们接入 request/decide 流程,或文档化 `auto-grant`

## 5. REST + UI

- [x] 5.1 在 `packages/ui-dashboard/src/api.ts` 加 REST 路由:`GET api/approvals/pending`、`POST api/approvals/:id/decision`、`GET api/audit`;cancel/merge/discard 路由全部经过门控
- [x] 5.2 把 `packages/ui-dashboard/src/client/App.tsx`(及 ui-workbench 中的)merge/discard 确认弹窗替换为 request→decision 调用;加挂起审批徽标与只读审计视图
- [x] 5.3 路由器单测:被门控合并的成功/失败、审计查询、挂起列表/决定

## 6. 测试 + 文档

- [x] 6.1 引擎端到端测试:confirm-required 的合并无令牌被拒、有有效令牌放行、日志中"决定先于结果"的顺序正确;日志不可写则中止操作
- [ ] 6.2 真实 profile 冒烟(手动,记录在 commit message):仪表盘合并弹确认;无令牌工具调用被拒;重启后审计页仍显示条目
- [x] 6.3 更新 `docs/SECURITY-AUDIT.md`(§1.6 loopback 风险现由门控 + 日志缓解)、`docs/USAGE.md`(策略文件、新工具/端点、headless 合并流程)

## 7. 冲突语义与裁决留痕(用户合并规则扩展)

- [x] 7.1 冲突判定改为实际 apply 失败:改 `packages/orchestrator/src/core.ts` 的 `markConflicts`/聚合与合并应用路径,去掉"被 ≥2 agent 改过即冲突"的文件级启发式;仅应用失败的文件进入 `conflictFiles`;干净文件(含多 agent 不重叠改动)默认合并
- [x] 7.2 merge 请求类型(`types.ts`/REST/工具参数)增加可选 `resolutions: Record<file,{kind:'agent',agent}|{kind:'manual'}|{kind:'skip'}>`;执行时写入 run 时间线——扩展 change A 的 `ExecutionEvent.kind` 增加 `merge-decision`(消费端对未知种类容忍)与审计日志(`audit-trail` 裁决事件)
- [x] 7.3 ui-diff 对齐:冲突标注只来自真实冲突;用户逐文件裁决(采纳 agent/手动编辑保留/跳过)随"合并所选/单 agent 合并"请求回传为 `resolutions`;无裁决的冲突文件不被写入
- [x] 7.4 headless 工具(经审批令牌)不携带 `resolutions` 时:全量应用,任一真实冲突整体中止并返回冲突清单与指引,不做静默单侧合并;中止事件入审计
- [x] 7.5 单测/集成:不重叠多 agent 改动默认合并不弹冲突;重叠文件仅在应用失败时标冲突;工具合并被冲突中止且 base 零变更;裁决载荷写入 history(`merge-decision`)与审计;`resolutions` 含 manual/skip 语义
- [ ] 7.6 真实 profile 冒烟(手动,记录 commit message):干净合并一键完成;构造重叠改动→冲突如实提示→用户对比 diff 逐文件裁决→合并;工具调用遇冲突中止
