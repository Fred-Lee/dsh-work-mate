## ADDED Requirements

### Requirement: 机器可读的钉版版本清单
仓库 SHALL 维护一个单一、机器可读的清单(例如仓库根部的 `toolchain.json`),为 Helmsman 工作台 profile 记录:已验证的 DSH harness/平台版本、钉死的 `@deepseek-ai` 内核包(`cordis`、`dsh-tools`)、所需社区插件及各自确切版本(better-sidebar、plugin-check、skill-manager、agfs、outline、vision-router、mnemon、mcp-adapter、auto-review、annotation),以及 Node/pnpm 的 engines 约束。该清单 SHALL 是权威来源:散文文档 MUST NOT 钉一个与清单不同的版本;文档与清单冲突 SHALL 视为清单违规。

#### Scenario: 清单列出每一项必需依赖
- **WHEN** 操作员在全新搭建后检查清单
- **THEN** 文档所述工作台 profile 所需的每一项 DSH 平台包、`@deepseek-ai` 内核包与社区插件都在清单中有条目,带各自版本、且插件带 `dsh plugin add` 使用的来源形式

#### Scenario: 文档与清单不一致
- **WHEN** 某份搭建文档对同一组件钉的版本与清单不同
- **THEN** 校验报告不一致,并修正文档(清单是权威)

### Requirement: 针对已安装 profile 的脚本化校验
仓库 SHALL 提供一个校验脚本(`scripts/check-toolchain`),分两种模式校验清单:离线结构检查(结构形态、内部一致性、版本唯一)与 live profile 检查(对照目标 profile 的 `dsh plugin`/`pnpm ls` 输出与运行中的 Node/pnpm 引擎比较)。当任一钉死组件缺失、版本不符、或引擎约束不满足时,脚本 SHALL 以非零退出码结束并打印差异。

#### Scenario: 已安装 profile 与清单一致
- **WHEN** 操作员对"已装插件与引擎恰好等于清单"的 profile 执行检查
- **THEN** 脚本以 0 退出并打印简明 OK 汇总

#### Scenario: 已安装 profile 偏离清单
- **WHEN** 某个社区插件缺失、版本不一致,或本地 Node/pnpm 不满足清单的引擎区间
- **THEN** 脚本非零退出,并逐一列出偏离组件及其期望值 vs 实际值

### Requirement: 清单的持续验证
仓库 SHALL 在每次触碰清单或搭建文档的变更上自动执行结构 + live profile 校验(CI workflow),校验失败时 SHALL 阻断该变更。

#### Scenario: 携带 CI 的清单变更
- **WHEN** 某次提交修改 `toolchain.json` 或搭建文档并推送 CI
- **THEN** 校验任务运行;校验失败则阻断变更,迫使其成为带文档化理由的有意版本提升

### Requirement: 派生的兼容性文档
仓库 SHALL 维护 `docs/COMPATIBILITY.md`,记录已知可用与已知损坏的版本组合(例如导致 `CallId`/`ToolCallId` 导入失败的 `dsh-tools` alpha 线 vs rc 线不匹配),并 SHALL 使该文档与清单保持一致;若文档引用了清单中不存在的组件版本,检查脚本 SHALL 判定失败。

#### Scenario: 记录损坏的组合
- **WHEN** 某 Helmsman 版本与某 DSH/tools 版本之间存在已知不兼容配对
- **THEN** 该配对被记录在 `docs/COMPATIBILITY.md` 中并附症状描述,且清单钉住的版本避开该损坏配对
