# Design — Track the DSH Host Line

## D1 兼容性只由 peer 决定，所以 peer 必须宽

宿主判定（`packages/boot/app-boot/src/plugin-compatibility.ts:63-80`）：遍历
`peerDependencies`，只挑 `name === '@deepseek-ai/dsh'` 或 `startsWith('@deepseek-ai/dsh-')`
的项，用 `semver.satisfies(runtime, requirement, { includePrerelease: true })` 判定；
不满足就整包跳过，并在启动日志里给出 incompatible 警告。
`workspace:^` / `~` / `*` 视为当前 runtime。`dependencies` 与其余 scope
（`@linxin666/*`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`）不参与判定
——所以那批"没有任何 dsh peer"的社区插件升级后也不会被拒（它们可能仍在运行时出问题，
但预检放行）。

结论：workmate 的 `@deepseek-ai/dsh-tools` peer 固定 `*`（toolchain 门禁强制），
这样**任何**宿主版本都不会把它拒之门外。

## D2 运行时用宿主那份内核，devDependency 只是构建基准

官方说明（`docs/user/develop/basic/publish.zh.md:103`）：linked checkout 保留自己的
`node_modules`，但**需要与宿主共享实例的 dsh 包要同时写进 peerDependencies 与
devDependencies**，运行时解析会把 peer 指向安装中的副本，devDependency 供类型检查与
独立测试。解析器实现见 `profile-resolution/resolver.ts:87`（linked importer 在祖先
`node_modules` 位置应用当前 peer 声明）与 `:213-220`（读取 manifest 的 peer 名单）。

因此本次换线只需要动 devDependencies + toolchain 记录；`src/**` 不需要因为宿主换版而
改写——前提是新旧两条线的 API 面仍然相容。实测：0.2.1-alpha.1 的 `DefineToolOptions`
与 0.1.2-alpha.5 的字段集合一致（name/description/parameters/output/timeoutMs/
isConcurrencySafe/finalizeContent/presentCall/presentResult），`ToolExecution` 里
`callId: ToolCallId`（历史上 0.1.2-rc 线用旧名 `CallId` 的坑已随 alpha 线消失）。

## D3 schemastery 必须与 dsh-tools 依赖同线

换线后第一次 `pnpm typecheck` 只在 `src/config.ts:72` 报 TS2322：program 里同时存在
我们钉的 schemastery 3.18.2 与 `dsh-tools@0.2.1-alpha.1` 依赖的 `~3.18.5-alpha.1`，
两份 `Schema` 类型不兼容（`meta.default` 的 `SchemaOutput` 含 `Volatile`）。
把我们的 `dependencies['@deepseek-ai/schemastery']` 对齐到 `3.18.5-alpha.1` 后即通过。
这条约束写进 `toolchain.json.knownIssues[0]`，升级仪式第 1 步也据此对齐。

## D4 门禁：借宿主的判定函数 + 零依赖不变量

`scripts/check-host-compat.mjs` 做三件事：

1. **不变量**（永远可执行、零依赖）：所有 `@deepseek-ai/dsh*` peer 范围必须是 `*`
   ——由构造保证"任何宿主版本都不会拒"。
2. **借宿主判定**：若本机存在宿主构建
   `packages/boot/app-boot/lib/index.js`（或 `--host-lib` / `DSH_APP_BOOT_LIB` 指定），
   直接 `import { evaluatePluginCompatibility }` 跑我们自己的 manifest，得到与宿主
   装载时**逐字相同**的结论（`undefined` = 不会被拒）。
3. **基线漂移**：读共享 store 里实装的 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools`
   版本，与 `toolchain.json.profile.dsh` 比对，不一致就失败并提示"改 toolchain +
   devDependencies，再跑 typecheck/test/build"。

`--root <dir>` 让用例可以在临时夹具上跑；`--structural` 强制只跑不变量（CI 无宿主
检出时可用）。用例见 `scripts/check-host-compat.test.mjs`（6 例，含窄范围被拒的夹具）。

## D5 声明文件构建（原 P2-8）

两处修复：
- TypeScript `^5.6.3` → `^5.7`（实装 5.9.3）：`tsconfig.decls.json` 里的
  `rewriteRelativeImportExtensions` 是 5.7 才有的选项，5.6.3 直接 TS5023。
- `tsconfig.decls.json` 的 `exclude` 补上 `src/client`：此前 decls program 把 client
  文件也拉进来（`extends` 的 exclude 会被覆盖），client 的 ambient
  `effect(fn): void` 与 cordis 的 `effect(fn, label?)` 合并后只剩一个参数，
  于是 `guidance/index.ts` 的 `scope.effect(fn, label)` 报 TS2554。
  声明树本来就只服务宿主入口（client 由 `tsconfig.client.json` 单独检查、
  esbuild 打包）。

修完后 `pnpm build` 退出码 0。但 emitted `.d.ts` 仍用源码相对的 `.ts` 说明符
（实测 TS 5.9 在 `emitDeclarationOnly` 下不改写声明里的相对路径），而 JS 运行时只有
一个 esbuild bundle，没有任何 `.js` 兄弟文件可指——所以根导出**撤掉 `types` 条件**，
声明树降级为内部参考。要做可消费的公共类型需要声明打包（rollup-plugin-dts /
api-extractor 级别），当前没有消费者，不做。
