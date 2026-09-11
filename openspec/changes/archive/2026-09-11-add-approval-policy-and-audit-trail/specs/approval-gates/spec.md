## ADDED Requirements

### Requirement: 敏感操作的可配置风险策略
系统 SHALL 加载操作者策略(`~/.helmsman/policy.json`,可用 `HELMSMAN_HOME` 覆盖),把每类敏感操作——merge、discard、cancel、worktree/任务清理、topology 删除——分类为 `confirm-required`(需确认)或 `auto-grant`(自动放行);merge、discard 与 worktree 清理的默认值 SHALL 为 `confirm-required`,以在操作者未显式退出时保持当前"破坏性变更前需确认"的行为。

#### Scenario: 默认策略保持今天的行为
- **WHEN** 操作员在无 `policy.json` 的全新 Helmsman 上运行
- **THEN** merge、discard 与 worktree 清理需要确认,与当前 UI 确认流程一致

#### Scenario: 操作者放宽或收紧某一类操作
- **WHEN** 操作员编辑 `policy.json`,把 `discard` 标为 `auto-grant`,或把某只读操作标为 `confirm-required`
- **THEN** 只有该操作的把关发生变化,策略其余部分不受影响

### Requirement: 敏感操作需要经过校验的确认令牌
每个敏感操作 SHALL 都经过服务核心(而非仅 UI)中的代码级门控:只有显式调用 `requestConfirmation`(指定操作与其作用域)后,门控才签发一个短期一次性确认令牌;且操作 SHALL 仅当以匹配、未过期、未消费的令牌调用时执行。任何调用路径——REST 路由、注册工具或内部服务调用——SHALL 都不得绕过门控。

#### Scenario: UI 确认一次合并
- **WHEN** 仪表盘弹出确认对话框且操作者点确认
- **THEN** 客户端为 `merge(任务 X, agents A)` 请求令牌并提交,合并恰好在该作用域内执行

#### Scenario: 无确认的工具调用被拒绝
- **WHEN** 操作处于 `confirm-required` 时,`helmsman_merge_task` 在无有效匹配确认令牌的情况下被调用
- **THEN** 调用以"门控拒绝"错误返回,不发生任何合并或放弃

#### Scenario: 令牌复用被拒绝
- **WHEN** 已消费或已过期的令牌被提交给第二个操作
- **THEN** 操作被拒绝,状态零变更

### Requirement: 只读操作不产生门控开销
只读操作(任务状态、日志获取、事件时间线、产物/topology 读取)SHALL NOT 被门控。

#### Scenario: 观察永远不弹确认
- **WHEN** 客户端读取任意任务的状态、日志或事件时间线
- **THEN** 不需要确认令牌,也不会为被门控的决定产生审计条目
