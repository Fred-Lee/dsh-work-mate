## ADDED Requirements

### Requirement: 宿主版本跟随与兼容门禁

插件 SHALL 把所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 范围保持为 `*`
（SHALL NOT 收窄为具体版本），因为宿主只据这些范围判定兼容性，范围不满足即整包跳过装载；
构建基准线 SHALL 记录在 `devDependencies` 与 `toolchain.json`（`profile.dsh` + `require` +
`runtime`），dsh 内核包 SHALL NOT 出现在 `dependencies`。

仓库 SHALL 提供兼容门禁并在构建流程中可执行：它 SHALL 在宿主构建可用时调用宿主自己的
`evaluatePluginCompatibility` 判定本包 manifest，在不可用时退化为"dsh peer 全为 `*`"的
结构不变量，并 SHALL 在 `toolchain.json` 基线与实装内核版本不一致时报错。

宿主换线时 SHALL 按升级仪式执行：对齐内核 devDependency 与 schemastery 线 →
更新 `toolchain.json` → typecheck/test → 门禁与构建 → 重装 profile 并用
`--dump-config-schema` 核验（workmate 条目 `status: schema`、无相关 diagnostics）。

#### Scenario: 窄 peer 范围被门禁拦下

- **WHEN** `peerDependencies['@deepseek-ai/dsh-tools']` 被改成 `^0.1.2-alpha.5`
- **THEN** `pnpm verify:host-compat` 以非零退出码报告"must stay '*'"，并说明宿主会拒绝装载

#### Scenario: 换线后门禁暴露基线漂移

- **WHEN** 宿主内核升级到新线而 `toolchain.json.profile.dsh` 未更新
- **THEN** 门禁报告 host baseline drift，提示更新 toolchain 与 devDependencies 后重跑

#### Scenario: 真机装载核验

- **WHEN** 在 0.2.1-alpha.1 宿主上 `dsh plugin --profile <p> add <本仓库>` 并运行
  `dsh --profile <p> --dump-config-schema`
- **THEN** 退出码 0、`complete: true`、workmate 条目 `status: schema`、无 workmate 相关
  diagnostics
