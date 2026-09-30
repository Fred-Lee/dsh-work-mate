## MODIFIED Requirements

### Requirement: 插件入口形态

入口 SHALL 具名导出 `name`、`inject`、`Config`（TypeScript interface）、`apply`，
不得使用 default export。`apply` SHALL 经 `ctx.provide('workmate.proposal', …)`
注册提案服务，并以 `declare module '@deepseek-ai/cordis'` 扩展 `Context` 接口给出
服务类型。`inject` SHALL 只声明**每个 profile 都存在**的服务：agent 工具面 SHALL 只
依赖 `tools`。可选服务 SHALL 经 reactive `ctx.inject([...], scope => …)` 惰性装配，
SHALL NOT 用 `ctx.get` 做一次性探测，也 SHALL NOT 写进模块级 `inject`。

具体地：`webServer` 只由 `dsh-web-app` bundle 装载（headless / acp / sdk profile 均无），
因此 UI 挂载 SHALL 在 `ctx.inject(['webServer'], …)` 回调内完成——非 web profile 下
SHALL NOT 因缺 `webServer` 而 PENDING，工具面 SHALL 照常注册。客户端半 SHALL 零硬依赖：
better-sidebar tab 与 `slots` 对话入口 SHALL 各自惰性注册，任一第三方服务缺失 SHALL NOT
影响另一个入口。

#### Scenario: 提案服务在宿主内可用

- **WHEN** 宿主完成插件装载
- **THEN** fiber 不因依赖缺失而 PENDING，`workmate.proposal` 服务 ACTIVE，日志输出 `service ready`

#### Scenario: 非 web profile 下工具面仍可用

- **WHEN** 在无 `webServer` 的 profile（headless/acp/sdk）装载本插件
- **THEN** fiber ACTIVE、`workmate_*` 工具全部注册，UI 不挂载且无报错

#### Scenario: 第三方侧栏插件缺失时对话入口存活

- **WHEN** profile 未装或停用 `dsh-better-sidebar`
- **THEN** 客户端半仍注册 `conversation.chat.assistant-actions` 与 `conversation.input.left`
  两个入口（仅缺 tab），日志无 error

### Requirement: 配置定义

插件配置 SHALL 包含 `workmateHome`（默认 `'workmate'`）、`maxConcurrent`（默认 `3`）、
`gitnexusEnabled`（默认 `true`）、`weknoraBaseUrl`（默认 `''`）、`openspecRoot`
（默认 `'openspec'`）五项；显式传 `undefined` 的键 SHALL NOT 覆盖默认值。
`openspecRoot` SHALL 在**所有**触及 OpenSpec 目录的路径上生效——提案目录生成、状态聚合、
生命周期前置校验（proposing / merging）、`wiki.md`+`commits.md` 写入、归档编排——实现中
SHALL NOT 出现 `'openspec'` 字面量作为目录名。

#### Scenario: 部分配置下的默认值补全

- **WHEN** profile 只配置 `maxConcurrent: 5`
- **THEN** 其余四项保持默认，`maxConcurrent` 为 5

#### Scenario: 自定义 openspecRoot 全链路一致

- **WHEN** `openspecRoot: 'spec'` 且提案的变更目录建在 `<root>/spec/changes/<id>/`
- **THEN** 状态聚合读出 active、proposing 前置校验通过、归档编排针对同一目录执行

## ADDED Requirements

### Requirement: 项目注册表持久化

项目注册表 SHALL 持久化为 `<DSH home>/<workmateHome>/projects.json`（原子 tmp + rename）。
文件缺失 SHALL 读作空注册表；内容损坏（非法 JSON 或非数组）SHALL 抛出 `StoreCorruptError`，
且**任何写路径都 SHALL NOT 覆盖损坏文件**（fail-closed，与提案存储同一纪律）。
注册表读失败时 `list()`/`get()` SHALL 以错误形式暴露，SHALL NOT 静默降级为空集。

#### Scenario: 损坏的注册表不被清空

- **WHEN** `projects.json` 含非法 JSON 后调用 `upsert('a', '/abs/a')`
- **THEN** 调用抛 `StoreCorruptError`，文件内容保持损坏前的原始字节

#### Scenario: 缺失文件读作空表

- **WHEN** `projects.json` 不存在时调用 `list()`
- **THEN** 返回空数组，不抛错
