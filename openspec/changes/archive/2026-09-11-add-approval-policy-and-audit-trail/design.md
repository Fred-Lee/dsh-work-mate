## 背景(Context)

破坏性舰队操作目前只在 SPA 里把关:ui-dashboard/ui-workbench 显示确认弹窗,而 REST 路由(`POST api/task/:id/cancel|merge|discard`、`api/topology/delete`)与注册工具(`helmsman_cancel_task`、`helmsman_merge_task` 带 `mode: merge|discard`)直接调用引擎(`OrchestratorCore.mergeTask/discardTask/cancelTask`,在 `packages/orchestrator/src/core.ts`;`worktree.removeTaskWorktrees/removeWorktree`,在 `packages/worktree/src/service.ts`),没有任何代码级门控与记录。`docs/SECURITY-AUDIT.md` §1.6 把"loopback 无鉴权"接受为风险;本变更不引入鉴权,但把"任意本机进程都能静默破坏舰队状态"这一部分关掉:为每个敏感变更加门控,并把每个被门控的决定记入日志。参考模式:MOVO 的审批门(risk 级别 + 审批作用域 + 持久化回执),缩放到单用户文件系统模型。

## 目标 / 非目标(Goals / Non-Goals)

**目标:**
- 每个敏感变更(merge、discard、cancel、worktree/任务清理、topology 删除)都经过服务核心的代码级门控;REST/工具/内部调用路径均无法绕过。
- 默认策略保持今天的交互流程(UI 确认后再破坏性变更),同时关闭 headless 无门控的缺口。
- 每个被门控的决定与运行完成,在副作用发生前落入追加式审计日志;日志出错即失败(fail-closed)。
- 所有接口可注入;引擎单测用放行一切策略 + 内存日志。

**非目标:**
- 账号、角色、RBAC 或远端审计上报(保持单用户 loopback)。
- 日志的防篡改(哈希链)——本地操作者自己的记录不在此范围内。
- 门控只读操作。

## 决策(Decisions)

### D1. 两阶段门控:`requestConfirmation` → `decide` → `execute(confirmation)`
门控(`packages/orchestrator/src/gate/`)暴露:
- `request(op, scope) → { approvalId }` — 记录一个挂起的请求,绑定到规范化作用域键(操作 + 任务/agent/文件 id)。
- `decide(approvalId, { approve }) → { confirmationToken | denied }` — 批准时返回一次性令牌(16 字节随机 hex),绑定作用域键并带 TTL(默认 5 分钟);拒绝时记录拒绝。
- `execute(op, scope, confirmationToken)` — 校验并消费令牌是否匹配该作用域;任何不匹配、过期、复用,或在操作处于 `confirm-required` 时缺失令牌,都抛出"门控拒绝"错误。

REST(`POST /api/approvals/:id/decision`)与工具(`helmsman_request_confirmation`、`helmsman_decide_confirmation`)驱动同一个门控,使 headless 舰队自动化与仪表盘交互完全一致。

- **理由**:对应 MOVO 把*策略决策*与*执行授权*分离的做法;单一强制点;UI 确认与 headless 流程是同一机制(令牌而非仅 UI 弹窗)。一次性 + 作用域绑定 + TTL 对单操作者足够,同时封死重放/换作用域。
- **考虑过的替代**:布尔 `confirm: true` 参数(任何调用者都能传——正是要封的洞);OS 原生弹窗(对 headless 不利);工具调用一律询问(破坏既有非交互用法)。均否决。

### D2. 策略文件 `~/.helmsman/policy.json`
`{ "operations": { "merge": "confirm-required", "discard": "confirm-required", "cancel": "auto-grant", "worktree-cleanup": "confirm-required", "topology-delete": "confirm-required" }, "tokenTtlSec": 300 }`。文件缺失 → 采用上面的默认值。只读操作永不查询策略。

- **理由**:cancel 可逆(中止在跑任务)且开发期高频,默认 `auto-grant`(仍记录日志);merge/discard/cleanup 永久改变仓库/worktree 状态,默认确认。MOVO 的风险分类(`read|write|dangerous`)映射到这里:只有 `dangerous` 类操作被门控。
- **说明**:这刻意让"原本未鉴权的工具驱动合并"现在需要确认。想要旧 headless 便利的操作者把 `merge`/`discard` 设为 `auto-grant`。

### D3. 日志是带 fsync-before-execute 的追加式 JSONL
`packages/orchestrator/src/audit/` 写 `~/.helmsman/audit/audit.jsonl`;每条 `{ v:1, ts, type: 'decision'|'run-completion', operation, scope, source: 'ui'|'tool', decision: 'granted'|'denied'|'auto-grant', outcome?, error? }`。放行路径在受保护代码运行**之前** fsync 决定条目,之后追加结果;fsync 失败即中止操作。读取经 `GET /api/audit`(按操作/任务/日期过滤),无任何变更端点。

- **理由**:MOVO"先回执后执行"的属性才是真正有价值的保证("任何破坏性事件都不会无记录发生");JSONL + fsync 在无新基础设施下即可获得。文件布局与既有文件系统状态约定一致(change A 为任务历史引入同一模式;A 落地后可抽取共享 JSONL 助手,但本变更刻意不依赖 A)。
- **考虑过的替代**:执行后再记日志(操作自身崩溃就静默了;保证更弱);数据库(超范围)。

### D4. 服务面集成点
- `OrchestratorService` 新增 `requestConfirmation`、`decideConfirmation`、`listPendingConfirmations`、`getAudit`,并把可选 `confirmationToken?` 透传进 `mergeTask/discardTask/cancelTask`。
- worktree 清理(`removeTaskWorktrees`)与 topology 删除在 orchestrator/worktree 服务边界门控,而不是塞进 git 管道层,保持 git 层无门控。
- UI 确认弹窗改为"审批请求 + 决定"调用;ui-dashboard 增加挂起审批徽标与审计视图。

### D5. 冲突语义与裁决留痕(用户合并规则的落实)
在既有门控执行路径上落实三条合并规则:
- **判定改为 apply-failure**:`mergeTask`/聚合逻辑由"文件级:被 ≥2 agent 改过即冲突"改为"尝试应用,失败的文件才是冲突"(spec `merge-conflict-resolution`)。干净文件默认合并;冲突文件列入 `conflictFiles` 并如实返回,不自动选边。改动的关键位置在 `core.ts` 的 `markConflicts`/聚合与 diff 应用路径,以及 ui-diff 的冲突标注数据来源。
- **裁决载荷随合并持久化**:merge 请求类型增加可选 `resolutions: Record<file, {kind:'agent',agent}|{kind:'manual'}|{kind:'skip'}>`;执行时写入 run 时间线(history 新增 `merge-decision` 事件种类,change A 的 `ExecutionEvent.kind` 需扩展,消费端对未知种类容忍)与审计日志(`audit-trail` 的"合并裁决与结果入审计")。它同时成为 `验收归档` DoD 的"人裁决"证据来源。
- **headless 中止**:工具路径(经审批令牌)提交时不带 `resolutions`;合并尝试全量应用,任一真实冲突即整体中止、返回冲突清单与指引,不做静默单侧合并。
- **理由**:这三条是用户对合并的既定规则(干净默认合并 / 真实冲突如实交人裁决 / 不替用户决定);放在 L-C 是因为 merge 执行路径、审批与审计写入本就在本变更改动面上,避免另起一次重复触碰 orchestrator 的变更。

## 风险 / 取舍(Risks / Trade-offs)

- [对 headless 工具调用方是破坏性变更] → 在 `docs/USAGE.md` + presets 里说明;新 `helmsman_request_confirmation`/`decide_confirmation` 工具保持非交互流程可行;`policy.json` 的 `auto-grant` 是显式退出开关。
- [审批 UX 卡住在跑运行] → 挂起审批可列出、对运行不阻塞,直到工具/REST 调用方真正执行;TTL 过期清除过期请求并返回 `approval-expired`。
- [每次被门控操作的 fsync 延迟] → 此类操作低频(merge/discard/cleanup),一次 fsync 可忽略。
- [作用域键冲突/不匹配] → 作用域键被规范化(排序 id、规范化路径),令牌绑定该键;单测覆盖换作用域尝试。
- [本变更与 change A 的 JSONL/存储工作重叠] → 刻意保持独立(无 apply 顺序依赖);后续重构可共享 JSONL 写入器。

## 迁移计划(Migration Plan)

先让门控与日志按"与当前 UI 行为一致"的默认值落地;以 `merge/discard: confirm-required` 运行并观察仪表盘流程;headless 便利场景文档化 `auto-grant`。回滚:策略回到默认值、门控代码移除——没有需要迁移的存量数据(日志是纯增量)。

## 开放问题(Open Questions)

- 现有用法中 DSH agent 会话(presets/research)是否会合法调用 `helmsman_merge_task`——如果会,那些 preset 需要在同一变更里补 request/decide 工具对(apply 时对照 `docs/WORKBENCH-SETUP.md` 流程验证)。
