# Tasks — Bootstrap WorkMate Plugin

## 1. 仓库结构切换

- [ ] 1.1 删除 Helmsman 产物：`packages/`、`scripts/`、`toolchain.json`、
      `pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`、
      `openspec/specs/`、`openspec/changes/archive/`、`docs/`（保留
      `docs/DSH-INTEGRATION-NOTES.md`）
- [ ] 1.2 重写根 `package.json`（单包 `workmate4dsh`，`dsh.bundle.patch` 声明）
- [ ] 1.3 重写 `.gitignore`、`vitest.config.ts`、`tsconfig.json`（严格选项内联）
- [ ] 1.4 重写 `AGENTS.md` / `CLAUDE.md` / `README.md` 为 WorkMate 版
- [ ] 1.5 `docs/DSH-INTEGRATION-NOTES.md` 标题与归属改为 WorkMate（内容不动）

## 2. 插件骨架

- [ ] 2.1 `src/config.ts`：`Config` interface + 默认值补全（§4.1 五项）
- [ ] 2.2 `src/features/proposal/store.ts`：`$DSH_HOME/workmate` 路径解析、
      目录确保、tmp+rename 原子写骨架
- [ ] 2.3 `src/index.ts`：`name` / `inject = []` / `Config` / `apply`，
      `ctx.provide('workmate.proposal', …)`，`declare module` 服务类型
- [ ] 2.4 `cordis.patch.yml`：仅 `workmate` 一行（D6）
- [ ] 2.5 契约静态检查脚本 `scripts/check-contract.mjs`（三处一致门禁，D9）

## 3. 构建与测试

- [ ] 3.1 `scripts/build.mjs`：esbuild host 打包（packages external）
- [ ] 3.2 单元测试：配置默认值、store 路径解析与原子写、契约检查自测
- [ ] 3.3 `pnpm build` / `pnpm typecheck` / `pnpm test` 全绿

## 4. 真机冒烟（里程碑一验收）

- [ ] 4.1 web profile 移除 15 个 `@helmsman/*` link 依赖与 bundle 条目，`pnpm install`
- [ ] 4.2 profile 以 link 方式装载 `workmate4dsh`，`pnpm install` 建链
- [ ] 4.3 `pnpm dsh --profile web --dump-config` 出现 workmate 层；
      `dsh web` 加载日志无 error、`workmate.proposal` 服务 ACTIVE
- [ ] 4.4 契约检查脚本入 CI 位（`pnpm verify:contract`）
