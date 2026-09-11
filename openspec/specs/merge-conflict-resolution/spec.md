# merge-conflict-resolution Specification

## Purpose
TBD - created by archiving change add-approval-policy-and-audit-trail. Update Purpose after archive.
## Requirements
### Requirement: 冲突以实际应用失败为准
合并时系统 SHALL 以"补丁实际无法干净应用(git 冲突)"判定冲突文件,不得以"某文件被多个 agent 修改"的文件级启发式判定;可干净应用的变更(含多 agent 对同一文件的不重叠改动)SHALL 被纳入默认合并。

#### Scenario: 不重叠改动不再被当作冲突
- **WHEN** 两个 agent 修改同一文件但 hunk 不重叠,补丁可干净应用
- **THEN** 该文件按默认合并处理,不进入冲突提示流程

#### Scenario: 真实应用失败才标冲突
- **WHEN** 某文件的补丁在同一区域重叠、`git apply` 失败
- **THEN** 该文件如实标记为冲突,其余可应用文件照常合并

### Requirement: 真实冲突由用户逐文件裁决
对判定的真实冲突,系统 SHALL 把用户引导到 diff 对比界面(unified/split/side-by-side),由用户逐文件选择采纳方案(某 agent 方案 / 手动编辑并保留待决定 / 跳过该文件);系统 SHALL NOT 在用户裁决前把冲突文件写入基础仓库,也不得自动代选一侧。

#### Scenario: 冲突文件等待裁决
- **WHEN** 存在真实冲突文件且用户尚未裁决就提交合并
- **THEN** 系统拒绝写入该文件并提示先裁决(或按用户选择跳过),基础仓库不出现该文件的半自动结果

### Requirement: headless 合并遇冲突即中止
非交互合并路径(如 `helmsman_merge_task`)SHALL 只允许"全干净"合并:任一并入文件存在真实冲突时,该次合并 SHALL 中止并返回冲突文件清单交用户处理;SHALL NOT 静默选择任一侧或忽略冲突继续。

#### Scenario: 工具合并被真实冲突中止
- **WHEN** 某 agent 经审批令牌请求全量合并,而其中某文件存在真实冲突
- **THEN** 合并中止,返回冲突文件清单与"请在 diff 界面裁决后重试"提示,基础仓库零变更

### Requirement: 裁决结果随执行留痕
用户提交的逐文件裁决 SHALL 作为该次合并的载荷持久化(写入 run 时间线的合并事件与审计,见 `audit-trail` 能力),使合并是否经人裁决、每处冲突如何裁决均可追溯。

#### Scenario: 裁决可追溯
- **WHEN** 用户完成一次含冲突裁决的合并后进入验收归档
- **THEN** 该合并的逐文件裁决记录可从 run 时间线/审计查询到,作为 DoD("merge 经用户裁决")的证据

