## ADDED Requirements

### Requirement: Bundle 声明与插件树挂载

插件包 `workmate4dsh` SHALL 在 `package.json` 中声明 `dsh.bundle.patch` 指向
`./cordis.patch.yml`，且 patch 内容 SHALL 以 `- insert:` 形式声明且仅声明 `id: workmate`
的插件树条目；该条目的 `name` SHALL 与 `package.json` 的 `name` 一致，插件入口导出的
`name` SHALL 为 `workmate`。三处标识由 `pnpm verify:contract` 静态门禁校验。
社区插件条目（swarm 编排、MCP 桥接）SHALL 在对应插件实际装入 profile 之前不得写入
patch——引用缺失插件会直接破坏 profile 装载。

#### Scenario: 装载进 web profile

- **WHEN** web profile 的依赖与 bundle 列表包含 `workmate4dsh` 并执行 `pnpm install` 后启动宿主
- **THEN** `--dump-config` 出现 `workmate` 层，加载日志无 error

#### Scenario: 三处标识不一致时构建前被拦截

- **WHEN** `cordis.patch.yml`、`package.json` 或 `src/index.ts` 任一处标识被改动而其余未同步
- **THEN** `pnpm verify:contract` 以非零退出码报告不一致项

### Requirement: 插件入口形态

入口 SHALL 具名导出 `name`、`inject`、`Config`（TypeScript interface）、`apply`，
不得使用 default export。`apply` SHALL 经 `ctx.provide('workmate.proposal', …)`
注册提案服务，并以 `declare module '@deepseek-ai/cordis'` 扩展 `Context` 接口给出
服务类型。M1 阶段 `inject` SHALL 为空数组（自足插件）；此后引入任何 inject 项前
SHALL 先经真机验证该服务在宿主中存在。

#### Scenario: 提案服务在宿主内可用

- **WHEN** 宿主完成插件装载
- **THEN** fiber 不因依赖缺失而 PENDING，`workmate.proposal` 服务 ACTIVE，日志输出 `service ready`

### Requirement: 提案持久化

提案聚合 SHALL 持久化为单文件 `<DSH home>/<workmateHome>/proposals.json`
（`workmateHome` 默认 `workmate`），写入 SHALL 经 tmp + rename 原子完成；
文件缺失 SHALL 读作空提案集，内容损坏 SHALL 抛出 `StoreCorruptError` 且任何写路径
都不得覆盖已损坏文件（fail-closed）。

#### Scenario: 原子写不残留临时文件

- **WHEN** 一次保存完成
- **THEN** `proposals.json` 为完整新内容且同目录无 `.tmp` 残留

#### Scenario: 损坏文件被报告且不被覆盖

- **WHEN** `proposals.json` 含非法 JSON 时启动插件并触发读操作
- **THEN** 服务在启动日志报告不可读，后续写操作被拒绝而不是重置文件

### Requirement: 配置定义

插件配置 SHALL 包含 `workmateHome`（默认 `'workmate'`）、`maxConcurrent`（默认 `3`）、
`gitnexusEnabled`（默认 `true`）、`weknoraBaseUrl`（默认 `''`）、`openspecRoot`
（默认 `'openspec'`）五项；显式传 `undefined` 的键 SHALL NOT 覆盖默认值。

#### Scenario: 部分配置下的默认值补全

- **WHEN** profile 只配置 `maxConcurrent: 5`
- **THEN** 其余四项保持默认，`maxConcurrent` 为 5
