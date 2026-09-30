/**
 * The guidance WorkMate contributes to DSH (design D2/D4 of
 * `adopt-dsh-native-config-and-guidance`): two runtime skills and one compact
 * system-prompt section.
 *
 * Before this, the same knowledge lived in Claude-Code-only files
 * (`assets/quality/claude/rules/*.md`, `agents/proposal-auditor.md`) that DSH
 * never reads, plus repeated MUST-prose inside tool descriptions. Here it is
 * one canonical body per topic, loaded on demand (skills) or contributed once
 * per assembly (prompt section).
 */
import type { RuntimeSkill } from './faces.ts'

export const PROPOSAL_FLOW_SKILL: RuntimeSkill = {
  name: 'workmate-proposal-flow',
  description:
    'WorkMate 变更提案流程：八态生命周期、workmate_* 工具地图与跨工具纪律（决策日志、卡点上报、Wiki 登记、提交标记、归档与回退由插件编排）。',
  whenToUse:
    '当任务涉及创建/推进/归档一个变更提案，或需要知道 workmate_proposal_* 工具之间怎么配合时。',
  content: `# WorkMate 变更提案流程

八态：draft → proposing → reviewing → ready → implementing → merging → archiving → archived。
工具前缀 \`workmate_\`；每一步都有硬前置，不满足时工具返回可读错误且不改状态。

## 顺序

1. **创建**：\`workmate_proposal_create\`（id / title / projects）。projects 用项目注册表里的
   名字（未注册先在面板注册）；创建时按配置向目标项目同步 OpenSpec 资产。
2. **推进**：\`workmate_proposal_archive\`（mode=advance）逐态前进。前置：
   - proposing：\`<openspecRoot>/changes/<id>/proposal.md\` 存在
   - reviewing：提案分支 \`proposal/<id>\` 存在
   - ready：该分支已合并进 main
   - implementing：自动创建 worktree（端口注入 / 配置复制 / 依赖安装）
   - merging：声明的 wiki 任务类型已被 \`workmate_wiki_link\` 覆盖
   - archiving：实现分支已合并进 main
3. **回退**：相邻回退自由（\`transition\` 到前一状态即可）。\`archived → archiving\` 会把各项目
   \`changes/archive/*-<id>/\` 搬回 \`changes/<id>/\`——不要手工 mv 目录。

## 三条硬纪律

- **方向性选择落决策日志**：\`workmate_proposal_decide\`（decision + rationale）。推翻旧决策
  必须带 \`supersedes=<旧 id>\`；禁止静默改口，审计会检查链是否闭合。
- **同一方向卡两轮必须上报**：\`workmate_proposal_block\`（question + 已尝试的 tried）。
  卡点会出现在面板；拿到答复后用 \`workmate_proposal_unblock\` 解除。
- **提交信息带标记**：本提案相关提交写 \`[proposal:<id>]\`，WorkMate 以此关联提交。

## 归档与重开

归档由编排完成：审查门（\`changes/<id>/review.md\` 无未解决 CRITICAL）→
\`openspec archive --yes\` → \`gitnexus analyze --force\` → worktree 回收。
用 \`workmate_proposal_archive\`（mode=archive）触发；返回的 \`orchestration.steps\` 是事实，
出现 failed 就按摘要修复后重试（幂等：已归档的项目记 skipped），**不要绕过编排手跑
openspec archive**。\`force\` 只跳过审查门，其余步骤照跑——默认先补 review.md。

归档后发现问题：回退到 archiving（目录搬回）修正后再归档。

## 知识查询

- 代码事实用 \`workmate_knowledge_query\`（GitNexus：query / context / impact）。目标仓库需先
  \`gitnexus analyze\`；返回 \`note\` 表示查询不可用，此时降级为静态阅读并如实标注，不要臆造关联。
- 文档/规范用 \`workmate_knowledge_search\`（WeKnora；未配置会返回禁用说明）。
- 归档前每个声明 wiki 的任务必须已登记页面引用（\`workmate_wiki_link\`，pageType 为
  concept / synthesis / entity 之一）。
`,
}

export const PROPOSAL_AUDIT_SKILL: RuntimeSkill = {
  name: 'workmate-proposal-audit',
  description:
    'WorkMate 提案审查规程：经 GitNexus 交叉验证消费方完整性、requirement↔task 映射、design 可实现性、回滚完整性与决策链一致性，产出结构化 review.md（归档门读取）。',
  whenToUse: '提案文件写好后、生成 tasks 前审查提案；或归档被审查门阻断需要补 review.md 时。',
  content: `# WorkMate 提案审查（proposal-auditor）

产出是**结构化审查报告** \`<openspecRoot>/changes/<id>/review.md\`——WorkMate 的归档门读取
\`## CRITICAL 问题\` 节，未勾选（\`- [ ]\`）的条目会阻断归档。

## 输入

1. \`changes/<id>/proposal.md\` 与 \`design.md\`（有 \`specs/\` 子目录则一并读）。
2. 从 Impact / 消费方枚举提取「受影响模块清单」。

## 审查步骤（按序）

1. **消费方完整性（GitNexus 交叉验证）**：对清单中每个关键符号跑
   \`workmate_knowledge_query\`（action=impact，direction=upstream）；对每个模块用 action=query
   （提案标题 + 模块名组合）。**查询命中但提案未声明的模块 = 遗漏消费方**，记疑问项或 CRITICAL。
   返回 \`note\`（未索引/超时）时在报告里注明「知识查询不可用，消费方清单基于静态阅读」。
2. **requirement ↔ task 映射**：每条 requirement 是否都有 design 决策支撑（tasks 未生成时核对
   What Changes 是否全部有设计覆盖）。
3. **design 可实现性**：找出使 requirement 不可能实现的决策——矛盾、缺失的数据流、未声明的依赖。
4. **回滚完整性**：回滚方案是否覆盖全部有状态 / 破坏性变更。
5. **模块复用**：design 引入的新抽象若与既有实现职责重叠，记建议补充项（附符号名）。
6. **决策日志一致性**：逐条比对提案的 \`decisions\`——supersedes 链是否闭合（被推翻条目不得再被
   引用为现行决策）；现行决策与代码事实矛盾时记 CRITICAL。

## 输出

写入 \`changes/<id>/review.md\`，四节结构：

- \`## 确认项\` —— 已核对无问题的点，逐条带依据（文件 / 查询结果）。
- \`## 疑问项\` —— 阻塞性疑问标（BLOCKING）。
- \`## 建议补充项\` —— 非阻断建议。
- \`## CRITICAL 问题\` —— 每条 \`- [ ] CRIT-n <描述> — 违反：<约束> — 修复方向：<最小修复>\`；
  没有则写 \`- [x] 无未解决 CRITICAL 问题\`。

只陈述有依据的结论。
`,
}

/** Name + body of the single WorkMate system-prompt section. */
export const FLOW_SECTION_NAME = 'tool:workmate'
export const FLOW_SECTION_TEXT = [
  'WorkMate 变更提案已启用（八态生命周期 + 归档审查门）。需求 / 功能 / 重构类任务遵循：',
  '先 workmate_proposal_create（或复用已有提案），再用 workmate_proposal_archive(mode=advance) 逐步推进，',
  '每一步的硬前置按返回提示补齐；方向性选择必须 workmate_proposal_decide（推翻要带 supersedes），',
  '同一方向卡两轮必须 workmate_proposal_block；代码事实先经 workmate_knowledge_query 核实，不要凭记忆断言。',
  '完整规程见技能 workmate-proposal-flow，审查规程见 workmate-proposal-audit。',
].join('')
