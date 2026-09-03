# Helmsman 分发与发布指南

Helmsman 是一组标准 DSH 第三方插件。本文给出 4 种让其他人安装的方式，
从「零发布门槛」到「正式发布」，以及每条路径已验证的状态。

## 方式 A：直接克隆源码（最简单，零发布）

收件人克隆本仓库，在仓库根目录执行：

```bash
pnpm install && pnpm build
for p in worktree memory-topology orchestrator adapter-claude adapter-codex \
         adapter-pi adapter-oh-my-pi ui-dashboard ui-diff; do
  dsh plugin --profile <目标profile> add -w ./packages/$p
done
# 或只装组合包：
dsh plugin --profile <目标profile> add -w ./packages/bundle
```

要求：Node `^22.19 || >=24`、pnpm ≥10、dsh CLI。收件人需要**代码访问权**
（git 仓库）。适合团队内协作或把仓库开源。

## 方式 B：npm registry 发布（对外分发，推荐正式途径）

### 打包

每个包都已配置好发布元数据与 `prepack`（自动 `pnpm run build`）：
`files` 恰好包含 `dist/`（含 UI 的 React client bundle）与 `cordis.patch.yml`。

```bash
# 全量打包检查
for p in worktree memory-topology orchestrator adapter-claude adapter-codex \
         adapter-pi adapter-oh-my-pi ui-dashboard ui-diff bundle; do
  (cd packages/$p && pnpm pack --pack-destination /tmp/helmsman-pack)
done
```

### 发布

```bash
npm login                    # 需要 npm 账号（已加 publishConfig.access: public）
for p in worktree memory-topology orchestrator adapter-claude adapter-codex \
         adapter-pi adapter-oh-my-pi ui-dashboard ui-diff bundle; do
  (cd packages/$p && pnpm publish)
done
```

发布顺序无硬性依赖（9 个功能插件之间**运行时零相互依赖**，UI 对
orchestrator 只有 type-only devDep），但约定最后发 `@helmsman/bundle`。

### 收件人安装

```bash
# 一条命令拉全量（bundle 声明了全部 9 个插件为 dependencies）
dsh plugin --profile <目标profile> add @helmsman/bundle
```

首次发布前先发 `--tag next` 验证（`pnpm publish --tag next`），稳定后再发
latest。

## 方式 C：私有 registry（内网团队分发）

任意 npm 兼容 registry 均可（Verdaccio / Nexus / 公司 npm）：

```bash
npm config set registry https://your-registry
# 发布命令与 B 相同；收件人 profile 需能访问该 registry
dsh plugin --profile <目标profile> add @helmsman/bundle
```

## 方式 D：直接分发 tarball（已在本机完整验证 ✅）

无需任何 registry。打包后把 tgz 发给收件人（或放共享盘），收件人执行：

```bash
# 每个包一个 tarball
dsh plugin --profile <目标profile> add file:/path/to/helmsman-worktree-0.1.0.tgz \
  file:/path/to/helmsman-memory-topology-0.1.0.tgz \
  ... （9 个包）

# 或组合包 tarball（依赖仍指向 registry，见下方注意事项）
```

**验证记录（2026-09-03）**：在独立 profile `helmsman-dist` 中从 9 个 tarball
逐一安装 → `dsh --dump-config` 显示 9 条 `helmsman-*` → 启动 harness →
Dashboard/Diff 路由 200、API 正常。这是目前唯一**不依赖 registry** 且
**端到端跑通**的分发路径。

## 组合包（bundle）的两种形态与取舍

| 形态 | 安装体验 | 依赖来源 | 状态 |
|---|---|---|---|
| 9 个包逐个 tarball | 一条长命令 | 纯本地，零外网 | ✅ 已验证 |
| bundle tarball | 一条短命令 | 需 registry 解析 `workspace:*` 展开的版本 | ⚠️ 需配 registry 或用 B/C 方式发布后生效 |

仓库内的 `@helmsman/bundle` 包：`dependencies` 用 `workspace:*` 指向 9 个插件，
`dsh.bundle.patch` 聚合 9 行 `insert`。发布到 registry 后（B/C），
`workspace:*` 会在 publish 时展开为版本号，收件人 `add @helmsman/bundle`
即一次装齐；当前 tarball 形态下请按方式 D 逐个安装。

## 版本管理与兼容性

- **版本同步**：10 个包统一版本号（当前 0.1.0），升级时全部 bump，
  避免 bundle 依赖漂移。可用 changesets 或手动同步。
- **peer 依赖策略**：`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`
  （仅 memory-topology / orchestrator 使用，且为**可选 peer**）指向宿主
  harness 提供的实例，**绝不打包私有副本**——这是为了避免 `dsh-tools`
  与宿主 `dsh-llm` 的 `CallId` 等导出漂移导致运行时崩溃
  （已在 helmsman-dist 验证中遇到并修复：错误
  `'@deepseek-ai/dsh-llm' does not provide an export named 'CallId'`）。
  收件人 profile 需要 `@deepseek-ai/dsh-base`（自带 dsh-tools），
  因此 `dsh plugin add` 前 profile 应已能跑 `dsh web`。

## 安全提示（转给收件人）

- 社区插件（dsh-virtual-workspace / dsh-memory-manager / dsh-memory-palace）
  不在 Helmsman tarball 内，需收件人按 README 单独安装并自行完成
  [安全审计](SECURITY-AUDIT.md) §2 的检查。
- 各 agent 适配器会以本机权限执行 agent CLI；仅从可信来源安装。
