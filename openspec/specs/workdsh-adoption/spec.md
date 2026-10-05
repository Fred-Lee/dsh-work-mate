# workdsh-adoption Specification

## Purpose
TBD - created by archiving change adopt-workdsh-lessons. Update Purpose after archive.
## Requirements
### Requirement: 版本治理门禁

仓库 SHALL 维护 `toolchain.json` 作为依赖版本线的唯一权威源（`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-tools` 的 require 范围与宿主 DSH 基线），`pnpm verify:toolchain`
SHALL 对 `package.json` 的依赖声明做结构化对账，不一致时以非零退出码失败；该检查
SHALL 与 `verify:contract` 同列为本仓门禁。

#### Scenario: 依赖漂移被拦截

- **WHEN** `package.json` 的 dsh-tools 版本线被改动而 `toolchain.json` 未同步
- **THEN** `pnpm verify:toolchain` 失败并指出不一致的依赖

### Requirement: Skill 资产与幂等同步

插件 SHALL 内嵌 `archive-checklist` 与 `knowledge-usage` 两个技能（SKILL.md），
并在装载时按 `Config.skillSyncEnabled`（默认 true）幂等同步到宿主用户级技能目录：
目标已存在且含 SKILL.md SHALL 跳过（永不覆盖用户修改），缺失 SHALL 写入包内嵌
副本。同步 SHALL 不触碰目标项目的 `.dsh/skills/`。

#### Scenario: 用户修改不被覆盖

- **WHEN** 用户改过技能目录中的 SKILL.md 后重启宿主
- **THEN** 同步跳过该技能，日志报告 `synced 0` 为正确幂等行为

#### Scenario: 开关关闭时不写用户目录

- **WHEN** `skillSyncEnabled: false` 时启动
- **THEN** 用户技能目录无任何写入

### Requirement: 归档验收谓词

归档编排 SHALL 在执行 openspec archive 前校验所有根可解析关联项目的 `tasks.md`：
存在未勾选任务 SHALL 终止编排（状态不变，step 记录各项目 done/total）；`force: true`
SHALL 跳过该检查；无关联项目时 SHALL 跳过检查。

#### Scenario: 未完成任务阻断归档

- **WHEN** 某关联项目 tasks.md 含未勾选项时触发归档
- **THEN** 编排失败即停、提案状态不变、step 列出各项目进度

#### Scenario: force 显式跳过

- **WHEN** 携带 force 重新归档
- **THEN** 验收检查跳过，编排继续

### Requirement: 归档交付物摘要

归档编排成功 SHALL 为每个关联项目采集 `ArchiveManifest` 条目（关联提交短 hash、
`git diff --stat` 摘要、specs 是否更新、GitNexus 是否重建成功），随提案持久化；
看板已归档卡片详情 SHALL 渲染该摘要；无 manifest 的历史归档提案 SHALL 显示占位说明。

#### Scenario: 归档后看板可见变更摘要

- **WHEN** 多项目提案完成归档编排后展开其卡片
- **THEN** 每个项目显示提交数、diffStat 摘要与 reindex 结果

#### Scenario: 旧归档提案的占位

- **WHEN** 展开一个无 archiveManifest 的历史归档提案
- **THEN** 显示「无归档摘要」占位而非报错

