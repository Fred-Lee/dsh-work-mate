# Tasks — Adopt WorkDSH Lessons

- [ ] 1. `toolchain.json` + `scripts/check-toolchain.mjs`（structural 移植），
      并入 `pnpm verify:toolchain` 与门禁链
- [ ] 2. `skills/archive-checklist/SKILL.md`、`skills/knowledge-usage/SKILL.md` +
      `src/skills.ts` 幂等同步 + `Config.skillSyncEnabled`
- [ ] 3. 编排验收谓词：tasks 全勾前置检查（force 可跳过）+ 失败 step 逐项目进度
- [ ] 4. `ArchiveManifest`：编排采集（commits/diffStat/specsUpdated/reindexed）
      → 提案持久化 → client 归档卡片渲染
- [ ] 5. 测试（门禁对账、同步幂等、谓词阻断/force、manifest 采集与渲染）
- [ ] 6. 全量验证 + 真机验收（含 skills 目录同步与归档 manifest 端到端）
