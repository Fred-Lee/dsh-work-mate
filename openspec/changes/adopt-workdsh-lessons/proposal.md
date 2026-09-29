# Adopt WorkDSH Lessons

## Why

`docs/DESIGN.md` §9 对 WorkDSH 的六项分析产出了四个可立即落地的借鉴项（F 桌面载体
无代码动作、SwarmTaskConfig 依赖 swarm 插件接入，均不在本变更）。它们共同解决三个
真实缺口：依赖版本线散落在文档里无门禁；操作规范没有以 Skill 形式进入 Agent 的
工作目录；归档缺少「任务是否真的完成」的验收与交付物摘要。

## What Changes

1. **钉版治理门禁**（§9.4，移植 Helmsman 已验证实现）：新增 `toolchain.json` 作为
   版本唯一权威源（cordis / dsh-tools / 宿主 DSH 版本线），`pnpm verify:toolchain`
   结构化校验并入现有 contract 门禁链。
2. **Skill 资产**（§9.3）：包内嵌两个技能——`archive-checklist`（归档前验收清单：
   tasks 勾选纪律、`[proposal:<id>]` 提交标记规范）、`knowledge-usage`（GitNexus
   query/context/impact 的选择指南）；`src/skills.ts` 幂等同步到宿主 skills 目录
   （只补缺、永不覆盖，沿 Helmsman presets 纪律），`Config.skillSyncEnabled` 开关
   （默认 true）。
3. **归档验收谓词**（§9.2 的编排侧落地）：归档编排新增前置检查——所有关联项目的
   `tasks.md` 必须全部勾选（`[x]`），存在未完成项则编排失败即停；`force: true`
   可跳过（沿用既有 force 语义）。
4. **交付物摘要**（§9.5）：归档编排成功后产出 `ArchiveManifest`（逐项目：归档区间
   关联提交、`git diff --stat` 摘要、specs 是否更新、GitNexus 重建结果），随提案
   持久化；看板「已归档」卡片详情区渲染该 manifest（复用现有详情区，无新页面）。

## Capabilities

### 新增能力

- `workdsh-adoption`：版本治理门禁、Skill 资产同步、归档验收谓词与交付物摘要。

## Impact

- 新增 `toolchain.json`、`scripts/check-toolchain.mjs`（精简移植）、`skills/*/SKILL.md`、
  `src/skills.ts`；`orchestrate.ts` 增加验收前置与 manifest 收集；`config.ts` 加
  `skillSyncEnabled`；client 详情区加 manifest 渲染。
- 外部依赖不变；不接 SkillHub / dsh-market（§9.4 结论）；不做桌面载体（§9.6）。
- `SwarmTaskConfig`（能力组装 + done 谓词全量形态）依赖 dsh-swarm-orchestrator
  实际接入，届时单独提案。
