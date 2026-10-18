## ADDED Requirements

### Requirement: 角色名册与契约

插件 SHALL 提供固定 7 角色名册：`coordinator`、`requirement-evaluator`、
`solution-evaluator`、`frontend-dev`、`backend-dev`、`integration-tester`、`reviewer`。
每个角色 SHALL 有明确契约：职责、产出工件、可写域、权限预设、禁止项；契约 SHALL 可被
Run 读取并展示，SHALL NOT 由模型在运行中自行改写。

角色 SHALL 可裁剪：模板可以禁用不需要的角色，但 `coordinator` 与 `reviewer` SHALL 始终
存在；`reviewer` 的产出必须来自与实现者不同的身份。

#### Scenario: 纯调研模板

- **WHEN** 使用 `research` 模板创建 Run
- **THEN** 只启用 requirement-evaluator 与 reviewer，不派发前后端与集成测试

#### Scenario: 审查者不能是实现者

- **WHEN** 某个 worker 同时被指定为某 Task 的实现者与 reviewer
- **THEN** Run 创建被拒绝，错误指出身份冲突

### Requirement: 角色权限与写域边界

每个 worker SHALL 以宿主权限预设运行，权限只能由人设置；角色 SHALL NOT 自行提权。
权限预设 SHALL 按职责分级：`requirement-evaluator` 与 `reviewer` 只读；
`frontend-dev` / `backend-dev` / `integration-tester` / `coordinator` 为 workspace 写；
SHALL NOT 默认使用 `danger-full-access`。实现类角色 SHALL 只能修改 Task 声明的 `writes`
范围；超出范围 SHALL 在结算时被标记为 `violated` 并阻断该 Task 通过。评估/审查角色 SHALL
只读业务代码；测试角色按 `team-evidence` 的测试写域允许清单执行。

角色模型 SHALL 默认继承会话默认模型，并 SHALL 支持角色级覆盖；本版本 SHALL NOT 要求
为每个角色分别配置模型。

#### Scenario: 前端改到后端目录

- **WHEN** frontend-dev 的改动落到未声明的后端目录
- **THEN** worker_done 结算标记 `violated`，Task 不得进入 done，Run 上报

#### Scenario: 测试角色不改业务代码

- **WHEN** integration-tester 试图修改业务源文件
- **THEN** 该改动被拒绝或标记违规；允许修改测试脚本与临时验证脚本

### Requirement: 模板与角色装配

插件 SHALL 提供至少四类模板：`requirement-full`、`bug-fix`、`research`、`delivery`。
模板 SHALL 决定启用的角色、门禁强度、默认并发与预算；创建 Run 时 SHALL 记录所用模板
与角色集合，后续不得静默替换。

#### Scenario: 需求全流程模板

- **WHEN** 用 `requirement-full` 创建 Run
- **THEN** 启用全部 7 角色，G2 默认人确认，并发沿用配置上限
