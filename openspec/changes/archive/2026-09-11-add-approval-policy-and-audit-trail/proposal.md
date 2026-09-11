## Why

合并(merge)、放弃(discard)、取消(cancel)与 worktree 清理都是破坏性的舰队操作,但目前只有 UI 确认弹窗在把关——没有策略层、没有代码级门控、也没有"谁在何时做了什么决定"的记录。MOVO 平台验证了更严谨的形态:工具带 `risk_level`,敏感动作经过带作用域(`once`/`session`)的审批门,每个已执行的决定都落进持久化的回执/审计账本。本次变更把与之规模匹配的治理带给 Helmsman 的单用户 loopback 模型:对敏感操作加策略可配置的门控 + 追加式审计痕迹,但不引入账号、多租户或数据库。

## What Changes

- 在 `~/.helmsman/` 下引入轻量策略文件(JSON,可用 `HELMSMAN_HOME` 覆盖),对敏感操作(merge、discard、cancel、worktree 删除、diff 评论清除)给出默认风险级别与按操作的"需确认"开关;默认保持当前行为(需确认),不会变得更繁琐。
- 增加代码级门控:敏感操作必须携带显式确认令牌(由 UI 或工具调用方以 `mode:'merge'|'discard'` 获取),经策略校验后方可执行;门控位于服务核心,任何路径都绕不开。
- 增加追加式审计日志(`~/.helmsman/audit/*.jsonl`,每个被门控的决定与每次运行完成各一条):记录时间戳、操作、任务/agent/文件作用域、确认方式与结果;通过只读 REST 端点供 ui-dashboard 消费。
- 把 ui-dashboard/ui-workbench 现有确认弹窗改为"获取并提交确认令牌"的流程,不再直接变更。
- **修正合并冲突语义**:冲突判定从"文件级:被多 agent 修改即冲突"改为"以补丁实际应用失败为准";可干净应用的未冲突变更(含多 agent 不重叠改动)默认合并;真实 git 冲突如实引导用户到 diff 界面逐文件裁决,裁决前不写入基础仓库。
- **headless 合并遇真实冲突即中止**:`helmsman_merge_task` 等非交互路径只允许"全干净"合并;一旦真实冲突,中止并返回冲突文件清单交用户裁决,禁止静默选边。
- **裁决留痕**:merge 请求携带用户逐文件方案(`{file → 采纳 agents}` + 每冲突文件的裁决),随执行写入 run 时间线与审计,作为"merge 经人裁决"的证据(进入 `验收归档` 的 DoD 依据)。
- 保持引擎可测:门控与审计日志都是注入式接口;单测用放行一切(allow-all)的策略与内存日志。

## Capabilities

### New Capabilities
- `approval-gates`:对敏感舰队操作(merge/discard/cancel/清理)的策略可配置确认门控,含显式令牌校验与 once-vs-session 作用域语义。
- `audit-trail`:被门控决定、合并裁决与运行完成的追加式持久化日志,含只读查询面。
- `merge-conflict-resolution`:合并冲突语义——以实际应用失败判定冲突、干净变更默认合并、真实冲突交用户逐文件裁决、headless 中止交还用户、裁决结果随执行留痕。

### Modified Capabilities
<!-- 暂无。 -->

## Impact

- `packages/orchestrator`:merge/discard/cancel 执行路径(`core.ts`、`index.ts` 工具)纳入门控;策略与审计日志为注入式接口;**冲突判定改为实际 apply 失败;合并执行时把用户逐文件裁决写入 run 时间线(history 事件)与审计**。
- `packages/worktree`:删除/清理操作以同样方式门控(`service.ts`)。
- `packages/ui-dashboard` + `packages/ui-workbench`:确认弹窗改为签发 + 提交令牌;新增只读审计视图。
- `packages/ui-diff`:冲突标注与合并语义对齐"真实冲突"判定(默认合并干净文件,真实冲突引导逐文件裁决并随请求回传方案)。
- 文档:`docs/SECURITY-AUDIT.md`(更新 loopback 无鉴权风险节,反映代码级门控 + 日志)、`docs/USAGE.md`。
- 范围边界:仅单用户——无登录、无角色、无租户隔离;日志记录的是本地操作者上下文。
