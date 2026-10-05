# proposal-quality-gates Specification

## Purpose
TBD - created by archiving change add-decision-log-blockers. Update Purpose after archive.
## Requirements
### Requirement: 决策日志

提案 SHALL 支持追加决策条目（`decisions: [{id, decision, rationale, supersedes?, at}]`）：
Agent 经 `workmate_proposal_decide` 或 REST `POST /:id/decisions` 写入；`supersedes`
SHALL 指向同一提案内存在的旧条目 id（显式推翻），指向不存在的条目 SHALL 被拒绝。
详情 SHALL 返回完整决策日志；面板 SHALL 以时间线渲染并在 supersedes 时标注被推翻
条目。任何提案状态 SHALL 允许追加决策。

#### Scenario: 决策显式推翻

- **WHEN** Agent 对同一提案先落决策 D1 再落 D2 并声明 supersedes=D1
- **THEN** 日志含两条，D2 标注推翻 D1，时间序正确

#### Scenario: 悬空 supersedes 被拒

- **WHEN** supersedes 指向不存在的条目 id
- **THEN** 返回可读错误，日志不变

### Requirement: 卡点上报与解除

提案 SHALL 支持卡点上报（`blockers: [{id, question, tried?, answer?, status, at, answeredAt?}]`）：
Agent 经 `workmate_proposal_block` 上报（问题 + 已尝试），条目状态 `open`；
经 `workmate_proposal_unblock` 携带答复解除为 `resolved` 并记录 `answer` 与
`answeredAt`。面板 SHALL 将 open 卡点红色置顶、resolved 灰色带答案展示。
目标项目默认配置 SHALL 注入纪律：「同一方向卡两轮必须上报，禁止第三轮盲试」。

#### Scenario: 卡点往返

- **WHEN** Agent 上报卡点后用户经面板或 Agent 携带答复解除
- **THEN** 卡点状态 open→resolved，答案随条目持久化，面板红色转灰

#### Scenario: 旧提案读取兼容

- **WHEN** 读取不含新字段的旧 proposals.json
- **THEN** decisions/blockers 读作空数组，一切读写正常

### Requirement: 目标项目资产同步

创建提案且项目根可解析时，插件 SHALL 幂等同步资产到目标项目：`openspec/config.yaml`
（缺失时写入默认配置，含按工件分类的硬约束）、`openspec/schemas/workmate-review/`
（缺失时写入 schema 与全部模板）、`.claude/rules/*`、`.claude/agents/proposal-auditor.md`、
`.claude/hooks/check-proposal-tag.sh`（已存在则永不覆盖）、`.claude/settings.json`
（hooks 按命令全文去重合并，用户已有条目原样保留）。`Config.qualitySyncEnabled`
为 false 时 SHALL 不产生任何写入；无 projectRoot 时 SHALL 跳过并在返回 note 说明。

#### Scenario: 新项目一次同步齐备

- **WHEN** 在一个仅有 git 仓库的新项目上创建提案
- **THEN** 项目内出现 config.yaml、workmate-review schema、两份 rules、
  proposal-auditor、hook 脚本，且 settings.json 含 PreToolUse 检查

#### Scenario: 用户文件不被覆盖

- **WHEN** 目标项目已自定义 `.claude/rules/archive.md` 后再次创建提案
- **THEN** 该文件保持用户内容不变

### Requirement: review 工件与审查报告解析

`workmate-review` schema SHALL 在 design 与 tasks 之间插入 `review` 工件，且
`tasks.requires` SHALL 包含 `review`。插件 SHALL 解析 `changes/<id>/review.md` 的
四个小节（确认项/疑问项/建议补充项/CRITICAL 问题），CRITICAL 条目的 checkbox
状态即解决状态；提案详情 SHALL 返回该解析结果。

#### Scenario: tasks 依赖审查

- **WHEN** 查看 workmate-review schema 的 tasks 工件
- **THEN** requires 含 proposal、specs、design、review

#### Scenario: CRITICAL 着色

- **WHEN** 面板展开含未解决 CRITICAL 的提案详情
- **THEN** CRITICAL 条目红色显示、疑问项黄色、确认项常规色

### Requirement: reviewing 状态与审查门

提案状态机 SHALL 支持 `draft → reviewing → executing`（review/approve/unreview
三个流转，非法方向拒绝），`start` 直通路径保留。归档编排 SHALL 在 openspec archive
前执行审查门：关联项目的 `changes/<id>/review.md` 缺失或含未解决 CRITICAL 时 SHALL
失败即停（状态不变、step 记录原因）；`force: true` SHALL 跳过审查门。

#### Scenario: 无审查报告阻断归档

- **WHEN** 归档时关联项目内不存在 review.md
- **THEN** 编排失败、step 说明须先运行 proposal-auditor、提案状态不变

#### Scenario: CRITICAL 未解决阻断归档

- **WHEN** review.md 存在且含 `- [ ] CRIT-n` 条目
- **THEN** 编排失败、step 列出未解决条目

#### Scenario: Agent 可控审查流转

- **WHEN** Agent 以 mode=review / approve / unreview 调用 workmate_proposal_archive
- **THEN** 对应流转生效，非法方向返回可读错误

