# Track the DSH Host Line

## Why

宿主本体从 `0.1.7-rc.2` 换成 **`0.2.1-alpha.1`**（`@deepseek-ai/dsh-root 0.2.1-alpha.1`，
tag `dsh-v0.2.1-alpha.1`）后，profile 里几乎所有社区插件被宿主**跳过装载**。查证结果：

- 宿主只用 `peerDependencies` 里名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的范围
  判定兼容性（`packages/boot/app-boot/src/plugin-compatibility.ts:63-80`，
  `semver.satisfies(runtime, range, { includePrerelease: true })`），不满足即整包跳过；
  **`dependencies` 完全不参与判定**。
- 因此「peer 停在旧线」的插件在换线后集体失效；而 workmate 的
  `peerDependencies['@deepseek-ai/dsh-tools'] = '*'` 永远不会被拒——这是它没被卸载的原因，
  但它的构建基准线还停在 `0.1.2-alpha.5`，属于"能装、未必对"的状态。
- 运行时不依赖我们自己那份内核：宿主解析会把 linked importer 声明的 peer 指向**运行中
  安装的那份**（`packages/boot/app-boot/src/profile-resolution/resolver.ts:87,213-220`；
  官方说明 `docs/user/develop/basic/publish.zh.md:103`）。所以真正需要跟随的是
  **devDependency 构建基准线**，不是运行时依赖。

## What Changes

1. **换线到 0.2.1-alpha.1**：devDependencies `@deepseek-ai/dsh-tools@0.2.1-alpha.1`；
   `@deepseek-ai/schemastery@3.18.5-alpha.1`（必须与 dsh-tools 依赖的同一条线，否则
   同一 program 里两份 `Schema` 类型让 `z<Config>` 注解报 TS2322）；
   `@deepseek-ai/cordis@^4.0.2`（宿主实装 4.0.5-alpha.1）。**源码零改动**即通过
   typecheck 与 105 个测试。
2. **`toolchain.json` 改写**：`profile.dsh = 0.2.1-alpha.1`、
   `require['@deepseek-ai/dsh-tools'] = 0.2.1-alpha.1`、新增 `runtime.schemastery`，
   并把两条踩坑（peer 必须 `*`、schemastery 必须同线）写进 `knownIssues`。
3. **新增兼容门禁 `pnpm verify:host-compat`**：借宿主**自己的** `evaluatePluginCompatibility`
   判定我们的 manifest；没有宿主构建时退化为零依赖不变量——「每个 `@deepseek-ai/dsh*`
   peer 范围必须是 `*`」；同时比对 `toolchain.json` 基线与共享 store 里实装的内核版本，
   漂移即失败。`pnpm verify` 串起契约 + 钉版 + 兼容三条。
4. **升级仪式写进 AGENTS.md**：换线后按 装内核 → 改 toolchain → typecheck/test →
   verify/build → 重装 profile 核验 五步走。
5. **修掉声明文件构建缺陷（原 P2-8）**：TypeScript 提到 `^5.7`（5.9.3），
   `tsconfig.decls.json` 排除 `src/client`（client 有自己的 program，混进来会让
   client ambient 的 `effect(fn)` 覆盖 cordis 的 `effect(fn, label)`）。`pnpm build`
   现在退出码 0；由于 emitted `.d.ts` 仍使用源码相对的 `.ts` 说明符，根导出不再声明
   `types`（声明树保留为内部参考）。

## Capabilities

### 修改能力

- `workmate-plugin`：宿主版本跟随策略、兼容门禁与升级仪式；构建产物与导出面收敛。

## Impact

- 改动：`package.json`（钉版 / scripts / exports）、`toolchain.json`、
  `tsconfig.decls.json`、新增 `scripts/check-host-compat.mjs` 及其用例、
  `AGENTS.md`、`README.md`、`docs/DSH-INTEGRATION-NOTES.md`、`docs/DSH-FIT-AUDIT.md`。
- **源码零改动**：`src/**` 未因换线修改（0.2.1-alpha.1 的 `defineTool` 选项面与
  0.1.2-alpha.5 一致：name/description/parameters/output/timeoutMs/isConcurrencySafe/
  finalizeContent/presentCall/presentResult）。
- 真机证据：`--profile wm-smoke`（新建沙箱 profile）`plugin add` 成功、
  `--dump-config-schema` 退出码 0、`complete: true`、0 diagnostics、workmate 条目
  `status: schema` 且 15 个字段全部投影。
- 非目标：社区插件的升级/替换（`dsh-auto-review` / `dsh-mcp-adapter` /
  `@open-agfs/dsh-agfs` / `dsh-outline` 暂无兼容 0.2.x 的版本，需等上游或本地 fork）；
  Step 3（REST → `@Remote` / jobs）仍未开始。
