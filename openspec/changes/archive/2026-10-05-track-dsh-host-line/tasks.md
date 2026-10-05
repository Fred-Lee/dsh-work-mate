# Tasks — Track the DSH Host Line

- [x] 1. 换线：devDeps `@deepseek-ai/dsh-tools@0.2.1-alpha.1`、cordis `^4.0.2`（实装
      4.0.5-alpha.1）；`dependencies` schemastery 对齐 `3.18.5-alpha.1`（与 dsh-tools 同线）
      - 用 `npx pnpm@10 add` 绕过 store v10/v11 不一致
- [x] 2. `toolchain.json`：baseline 0.2.1-alpha.1、require.dsh-tools 同步、
      `runtime.schemastery`、两条 knownIssues（peer 必须 `*`、schemastery 必须同线）
- [x] 3. 源码适配：**零改动**（typecheck + 105 测试在新线全绿；唯一失败是 D3 的
      schemastery 双份类型，靠对齐版本解决）
- [x] 4. 门禁：`scripts/check-host-compat.mjs`（不变量 + 借宿主 `evaluatePluginCompatibility`
      + 基线漂移）+ `scripts/check-host-compat.test.mjs`（6 例）+ `pnpm verify` 串联
- [x] 5. 构建修复（P2-8）：TypeScript `^5.7`、decls 排除 `src/client`、
      根导出撤掉 `types` 条件；`pnpm build` 退出码 0
- [x] 6. 文档：AGENTS.md（契约 + 升级仪式 + 环境事实）、README、DSH-INTEGRATION-NOTES、
      DSH-FIT-AUDIT（P2-8 标记已修 + Step 2/3 进度）
- [x] 7. 真机核验（沙箱 profile `wm-smoke`）：`plugin add` 成功 →
      `--dump-config` 出现 `# == workmate4dsh` 层 → `--dump-config-schema` 退出码 0、
      `complete: true`、0 diagnostics、workmate 条目 `status: schema`、15 字段全投影
- [x] 8. 用户确认后把 workmate 装回 `web` profile（本变更不擅自改主 profile）——
      已于用户明确要求后执行：`web` profile 的 `dependencies` 为
      `workmate4dsh: link:/Users/fredlee/Documents/workspace/dsh-Helmsman`、bundles 含
      `workmate4dsh`；`--dump-config` 真机核验出现 `# == workmate4dsh` 层（2026-10-05）
