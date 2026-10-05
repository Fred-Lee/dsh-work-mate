# Tasks — Adopt WorkDSH Lessons

- [x] 1. `toolchain.json` + `scripts/check-toolchain.mjs`（structural 移植），
      并入 `pnpm verify:toolchain` 与门禁链；**修复残留 CI**
      `.github/workflows/toolchain.yml`（现引用已删除的脚本与 Helmsman 文档路径，
      paths 过滤改为 toolchain.json / package.json / workflow 自身）
      - 真仓校验通过；check-toolchain.test.mjs 5 用例（node --test）全绿；
        CI 残留问题解除
- [x] 2. ~~`skills/*/SKILL.md` + `src/skills.ts` 同步 + `Config.skillSyncEnabled`~~
      **改为原生 runtime skill**（见 design D2 修订）：`workmate-archive-checklist` 与
      `workmate-knowledge-usage` 随插件注册，不写用户目录
- [x] 3. 编排验收谓词：tasks 全勾前置检查（force 可跳过）+ 失败 step 逐项目进度
- [x] 4. `ArchiveManifest`：编排采集（commits/diffStat/specsUpdated/reindexed）
      → 提案持久化 → client 归档卡片渲染
- [x] 5. 测试（谓词阻断/force/逐项目进度、manifest 采集与落盘、两个新 runtime skill）
- [x] 6. 全量验证 + 真机验收（typecheck / test / build / 四条门禁 / `--dump-config`）
