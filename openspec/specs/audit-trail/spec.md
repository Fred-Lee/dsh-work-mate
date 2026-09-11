# audit-trail Specification

## Purpose
TBD - created by archiving change add-approval-policy-and-audit-trail. Update Purpose after archive.
## Requirements
### Requirement: 被门控决定的持久化审计日志
系统 SHALL 把每个被门控的决定记录到 `~/.helmsman/audit/` 下的追加式日志中(JSONL,每条决定一行):时间戳、操作、作用域(任务/agent/文件 id)、确认来源、决定(granted/denied)与最终结果。该日志 SHALL 在宿主重启后仍然存在。被门控的决定 SHALL 在其操作执行前完成日志写入;日志写不进去时,操作 SHALL 被中止(失败即关闭, fail-closed)。

#### Scenario: 决定先于执行落盘
- **WHEN** 某次被门控的合并获批并执行
- **THEN** 日志中存在包含该决定与结果的审计条目,且该条目持久化落盘之前合并并未执行

#### Scenario: 日志故障阻断操作
- **WHEN** 审计日志目录不可写,操作者确认了一项敏感操作
- **THEN** 操作以"日志不可用"错误被拒绝,而不是在无记录的情况下继续

#### Scenario: 历史在重启后仍存在
- **WHEN** 若干被门控操作后宿主重启
- **THEN** 之前所有日志条目按顺序仍可读

### Requirement: 运行完成审计条目
当任一舰队任务到达终态(merged 或 discarded)时,系统 SHALL 追加一条审计条目,记录任务 id、agents、结果及促成该合并/放弃的确认,使日志兼任治理角度的运行历史。

#### Scenario: 终态运行被审计
- **WHEN** 某舰队任务完成并被合并进基础仓库
- **THEN** 日志包含一条引用该任务 id 及其合并决定的运行完成条目

### Requirement: 只读的审计查询面
系统 SHALL 通过只读 REST 端点(`GET /api/audit`,可按操作/任务/日期区间过滤)暴露日志,MUST NOT 暴露任何追加、编辑或删除日志条目的端点;日志按其构造方式就是追加式的。

#### Scenario: 操作者查阅审计痕迹
- **WHEN** 操作者请求按任务 id 过滤的审计条目
- **THEN** 响应按时间顺序返回该任务的被门控决定与运行完成条目

#### Scenario: 不存在变更面
- **WHEN** 操作者试图通过任一暴露端点编辑或删除某条审计条目
- **THEN** 不存在这样的端点(404),日志文件保持不变

### Requirement: 合并裁决与结果入审计
当一次合并执行时,系统 SHALL 把该次合并的用户裁决载荷写入审计:操作(mode、agents、files)、每个真实冲突文件的用户裁决(采纳某 agent 方案 / 手动编辑待决定 / 跳过该文件)、`discardAfterMerge`、以及执行结果(成功/中止/部分中止)。执行结果 SHALL 与裁决记录在同一审计事件链中,使"该合并确实经用户裁决"可作为进入 `验收归档` 的证据。

#### Scenario: 裁决载荷随合并落审计
- **WHEN** 用户对含两个真实冲突文件的 run 提交合并(冲突 1 采纳 agent A、冲突 2 手动编辑保留)
- **THEN** 审计记录包含该文件→裁决映射及合并结果,可查询到逐文件裁决

#### Scenario: headless 中止也留痕
- **WHEN** 非交互路径的合并因真实冲突被中止并返回冲突清单
- **THEN** 审计记录该中止事件与其冲突文件清单,便于用户后续在 diff 界面处理

