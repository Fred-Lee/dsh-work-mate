## MODIFIED Requirements

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

## ADDED Requirements

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
