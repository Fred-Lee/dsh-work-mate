# Tasks — Adopt DSH-native Config and Guidance Surfaces

- [x] 1. 依赖：`@deepseek-ai/schemastery@^3.18.2` 进 `dependencies`（runtime：dist 里是 bare
      import，由本包 node_modules 解析），`toolchain.json.runtime` 记录同线
      - 安装用 `npx pnpm@10 add`（本机 pnpm 11 与 node_modules 的 store v10 不一致，
        `pnpm add` 直接报 ERR_PNPM_UNEXPECTED_STORE）；lockfile 只增该 importer 条目
- [x] 2. `src/config.ts`：`export const Config: z<Config>`（15 项带 default + description），
      保留 interface 与 `resolveConfig`，新增 `claudeAssetsEnabled`（默认 true）
- [x] 3. 契约测试 `src/config.test.ts`：逐字复制宿主 `isNativeConfigSchema` 谓词断言运行时
      `Config` 通过；schema 单独解析出的默认值与 `CONFIG_DEFAULTS` 全等；`basePort: 'x'`
      被 schema 拒绝；`dict` 字段集合与 `CONFIG_DEFAULTS` 键集合一致
- [x] 4. `src/features/guidance/`：faces（skills 面 + systemPrompt 加宽面 + TOOL_WORKFLOW 常量）、
      content（两个 skill 正文 + prompt 段）、index（惰性注册）
      - 证据修正：`systemPrompt` 已由 `@deepseek-ai/dsh-tools` 的类型图
        （`dsh-system-prompt@0.1.1-rc.2`）声明，重复声明会 TS2717；那条 alpha 线类型没有
        `getSectionOrder`，而运行中的宿主（0.1.7-rc.2）有 → 调用点写成可选 + 数值兜底
- [x] 5. `src/index.ts`：`export { Config }`（值与类型同名重导出），接 `registerGuidance(ctx)`，
      收敛 decide / block / unblock / wiki_link 描述里重复的 MUST 话术
- [x] 6. `.claude/**` 开关：`syncProjectAssets({claudeAssets})` 把资产表拆成
      OPENSPEC_COPIES / CLAUDE_COPIES，关闭时不进 settings 合并并返回说明性 note；
      api/index 透传 `claudeAssetsEnabled`
- [x] 7. 测试：guidance 4 例（注册 / 无 getSectionOrder 兜底 / 两服务全缺 / 单缺）、
      quality 新增 1 例（关掉后不产生 `.claude` 目录，openspec 资产照写）、
      index 入口 8 例（含 Config 为 native schema、两个 skill + 1 段注册、无服务仍 ACTIVE）
      —— 全量 105 例绿
- [x] 8. 文档：README §3（新配置项 + Schemastery 说明）、§6（skill / systemPrompt 分发表）、
      §8（资产两组 + 适用面表）、DSH-FIT-AUDIT Step 2 进度与 P1-4 结论修正
- [x] 9. 全量验证：`pnpm typecheck` ✅、`pnpm test` 105/105 ✅、`pnpm verify:contract` ✅、
      `pnpm verify:toolchain` ✅、`openspec validate … --strict` ✅、
      `node scripts/build.mjs` + `import('./dist/index.js')` 冒烟 ✅
      （`Config` native schema = true、`dict` 15 字段、`claudeAssetsEnabled` 默认 true）
      - ⚠️ `pnpm build` 的 `tsc -p tsconfig.decls.json` 步骤仍是既有缺陷（见
        `docs/DSH-FIT-AUDIT.md` P2-8），与本变更无关
