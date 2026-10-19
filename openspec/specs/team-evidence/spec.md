# team-evidence Specification

## Purpose
TBD - created by archiving change autonomous-agent-team. Update Purpose after archive.
## Requirements
### Requirement: 六份团队工件

每个 Run SHALL 在提案目录生成并维护六份工件：`REQ.md`（需求评估）、`PLAN.md`（技术方案）、
`TASKS.json`（DAG 任务）、`TEST.md`（集成测试）、`TEAM-REVIEW.md`（独立审查）、`SUMMARY.md`
（运行汇总）。工件 SHALL 标明作者角色、生成/更新时间与来源 Run；SHALL NOT 由非对应角色
代写（协调器只可汇总，不可代写 REQ/PLAN/REVIEW/TEST）。

`TASKS.json` SHALL 是任务与依赖的唯一事实源；Run 的 Task 列表 SHALL 从它派生，不得在
别处维护第二份任务清单。

#### Scenario: 需求评估缺失

- **WHEN** Run 尚未生成 `REQ.md` 就尝试进入方案门
- **THEN** G1/G2 阻断，错误指出缺失的工件与角色

#### Scenario: 任务清单单一来源

- **WHEN** 用户修改 `TASKS.json` 后重新加载 Run
- **THEN** Task 列表与依赖关系随之更新，不保留旧的并行 Task

### Requirement: 独立审查与测试证据

`TEAM-REVIEW.md` SHALL 由与实现者不同的身份产出，包含 severity、文件:行、问题、状态
（open/fixed/accepted）；`TEST.md` SHALL 包含测试场景、实际执行的命令、结果与失败复现。
两者 SHALL 引用真实存在的文件与命令输出；缺失证据或与 commit 不符时 SHALL 阻断对应门禁。

`TEAM-REVIEW.md` / `TEST.md` SHALL 接入现有 `review-gate` 与 `reviewEvidenceGate`：未解决的
CRITICAL 或证据文件不存在即失败；行号越界只 warn。

#### Scenario: 审查者与实现者同身份

- **WHEN** `TEAM-REVIEW.md` 的 reviewer 与实现该 Task 的 worker 相同
- **THEN** G4 失败，标记 `same-as-author`，不得进入归档

#### Scenario: 测试证据不可核

- **WHEN** `TEST.md` 引用的脚本或输出文件不存在
- **THEN** G3 失败并列出缺失引用，不以「已执行」文字代替证据

### Requirement: 结算汇总与归档映射

Run 结束时 SHALL 生成 `SUMMARY.md`：逐 Task 的 outcome、证据路径、commit、未解阻塞与
未完成项；并 SHALL 写入归档 manifest（项目、分支、提交、测试与审查结论）。`SUMMARY.md`
SHALL 与 Run 的最终终态一致，不得把失败报告为成功。

#### Scenario: 部分失败汇总

- **WHEN** 一个 Run 中有一个 Task 二次失败、其余成功
- **THEN** Run 终态为 partial，SUMMARY 列出失败 Task 与阻塞原因，归档前置被阻断

### Requirement: 集成测试写域允许清单

`integration-tester` SHALL 只能写测试与验证相关路径：`**/src/test/**`、`**/test/**`、
`**/tests/**`、`**/__tests__/**`、`**/*.test.*`、`**/*.spec.*` 及其 fixtures、
`scripts/verify/**`，以及运行期临时目录 `<worktree>/.workmates/<proposalId>/tmp/**`。
SHALL NOT 修改生产源码、迁移脚本、运行时配置或 CI 机密。

测试依赖变更（`pom.xml`、`package.json`、lockfile）SHALL NOT 视为默认允许，必须由单独
Task 提出并经人批准。若测试需要生产代码 seam，测试角色 SHALL 提交 Task 给实现角色，
SHALL NOT 自行修改。

Task 结算 SHALL 用 `git diff --name-only` 校验所有改动是否落在允许清单；越界 SHALL 标记
`violated` 并阻止 Task 进入 done。跨仓测试归属 target SHALL 在 `PLAN.md` 声明，测试不得
在每个仓库重复实现。

#### Scenario: 改到生产源码被拦

- **WHEN** integration-tester 修改了 `src/main/java/...` 下的业务文件
- **THEN** 结算标记 violated，Task 不得 done，Run 上报

#### Scenario: 改测试依赖需单独批准

- **WHEN** 测试需要一个新依赖并修改了 `pom.xml`
- **THEN** 该改动不被默认允许，必须走单独 Task 与人批准

