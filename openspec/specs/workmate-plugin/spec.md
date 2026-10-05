# workmate-plugin Specification

## Purpose
TBD - created by archiving change bootstrap-workmate-plugin. Update Purpose after archive.
## Requirements
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

插件 SHALL 在运行时具名导出 `Config`，且该值 SHALL 是 native Schemastery schema
（宿主以 `Symbol.for('schemastery')` brand + `type` + `meta` 三条件识别，见
`packages/boot/app-boot/src/config-schema/native.ts`），以便宿主对配置做校验与
配置 UI 投影；只导出 TypeScript 类型 SHALL NOT 视为满足本条。

配置 SHALL 包含 `workmateHome`（默认 `'workmate'`）、`maxConcurrent`（默认 `3`）、
`gitnexusEnabled`（默认 `true`）、`weknoraBaseUrl`（默认 `''`）、`openspecRoot`
（默认 `'openspec'`）、`projectRoot`（默认 `''`）、`qualitySyncEnabled`（默认 `true`）、
`claudeAssetsEnabled`（默认 `true`）、`basePort`（默认 `3000`）、`portStep`（默认 `10`）、
`copyFiles`（默认 `['.env', '.env.local']`）、`packageManager`（默认 `'pnpm'`）、
`weknoraEnabled`（默认 `true`）、`weknoraKbId`（默认 `''`）、`weknoraWikiRequired`
（默认 `false`）；显式传 `undefined` 的键 SHALL NOT 覆盖默认值。
`openspecRoot` SHALL 在**所有**触及 OpenSpec 目录的路径上生效——提案目录生成、状态聚合、
生命周期前置校验（proposing / merging）、`wiki.md`+`commits.md` 写入、归档编排——实现中
SHALL NOT 出现 `'openspec'` 字面量作为目录名。

#### Scenario: 部分配置下的默认值补全

- **WHEN** profile 只配置 `maxConcurrent: 5`
- **THEN** 其余各项保持默认，`maxConcurrent` 为 5

#### Scenario: 宿主识别配置 schema

- **WHEN** 宿主采集本插件的配置 schema
- **THEN** 运行时导出的 `Config` 通过 native Schemastery 身份检查，配置项可被校验与投影，
  不再出现 `Config is not a native Schemastery schema`

#### Scenario: 自定义 openspecRoot 全链路一致

- **WHEN** `openspecRoot: 'spec'` 且提案的变更目录建在 `<root>/spec/changes/<id>/`
- **THEN** 状态聚合读出 active、proposing 前置校验通过、归档编排针对同一目录执行

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

### Requirement: 流程指引与审查资产分发

插件 SHALL 在宿主提供 `skills` 服务时注册两个 runtime skill（`invocation` 采用
registry 默认，模型与用户均可调用）：

- `workmate-proposal-flow`：八态流程、工具地图与跨工具纪律（决策日志、卡点上报、
  Wiki 登记、提交标记、归档/回退由插件编排而非手工执行）；
- `workmate-proposal-audit`：结构化审查规程（消费方完整性、requirement↔task 映射、
  可实现性、回滚完整性、复用、决策链一致性）与 `review.md` 的机器可读形状。

插件 SHALL 在宿主提供 `systemPrompt` 服务时贡献一个流程段落；两个注册 SHALL 都是
惰性的（服务缺失即跳过，SHALL NOT 让 fiber PENDING）。

`.claude/**` 资产（rules / agents / hooks / settings 合并）SHALL 受
`claudeAssetsEnabled` 控制：`false` 时 SHALL NOT 写入任何 `.claude/**` 路径，但
OpenSpec 侧资产（`openspec/config.yaml`、`workmate-review` schema 与模板）SHALL 照常
分发。两组资产 SHALL 保持"已存在文件永不覆盖"与 hook 按命令全文去重的既有纪律。

#### Scenario: skill 随插件分发

- **WHEN** 宿主装配了 skills 服务并加载本插件
- **THEN** `workmate-proposal-flow` 与 `workmate-proposal-audit` 出现在技能目录中，
  fiber 卸载后自动注销

#### Scenario: 缺少 skills 服务时优雅降级

- **WHEN** 某个组合没有 skills / systemPrompt 服务
- **THEN** 插件照常 ACTIVE，工具与 UI 不受影响，无 PENDING、无报错

#### Scenario: 关掉 Claude 资产

- **WHEN** `claudeAssetsEnabled: false` 时创建提案
- **THEN** 目标项目不出现任何 `.claude/**` 文件与 settings 合并，而
  `openspec/config.yaml`、`openspec/schemas/workmate-review/**` 照常写入

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

