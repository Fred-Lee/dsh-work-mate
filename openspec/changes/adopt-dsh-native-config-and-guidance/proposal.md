# Adopt DSH-native Config and Guidance Surfaces

## Why

`docs/DSH-FIT-AUDIT.md`（2026-09-30）Step 2 的三项：把插件"已经写在别处"的东西
搬到 DSH 原生的面上。

1. **配置面不存在**（P0-3）：入口只 `export type Config`，运行时没有 `Config` 值。
   宿主采集插件配置 schema 时要求 native Schemastery schema，否则标记
   `unsupported`（`packages/boot/app-boot/src/config-schema/collect.ts:203-208`）——
   结果是 14 项配置**没有校验、没有配置 UI、没有默认值投影**，写错键也不报错。
2. **审查资产只对 Claude Code 生效**（P1-4）：`proposal-auditor` 以
   `.claude/agents/*.md` + `.claude/rules/*.md` 分发，而 DSH 源码里**没有任何**
   `.claude` 读取路径（除未装载的 `dsh-hooks-claude-code` 桥）；DSH 原生通道是
   `ctx.skills.register`（`packages/skill/skill/lib/types/index.d.ts:257`）。
3. **流程纪律藏在工具描述里**（P1-5）："卡两轮必须 block""方向性选择必须 decide"
   这类跨工具纪律写进了单个工具的 description，每个会话都要为它付上下文，
   而且换工具就看不见了；DSH 原生位置是 `ctx.systemPrompt.section`
   （`packages/core/system-prompt/lib/types/index.d.ts:239`）。

## What Changes

1. **配置改 Schemastery**（`src/config.ts`）：新增 `export const Config: z<Config>`，
   14 项各带 `default` + `description`；`Config` interface 保留为宿主契约类型，
   `resolveConfig` 继续做内部归一（既有嵌入方与测试不受影响）。新增依赖
   `@deepseek-ai/schemastery@^3.18.2`（与 profile 内 `dsh-tools` 的同名依赖同线）。
2. **两个 DSH 运行时 skill**（`src/features/guidance/`）：
   - `workmate-proposal-flow` —— 八态流程 + 工具地图 + 纪律（decide / block /
     wiki 登记 / 提交标记 / 归档触发 / 回退）；
   - `workmate-proposal-audit` —— 结构化审查规程（消费方完整性 / requirement↔task /
   可实现性 / 回滚 / 复用 / 决策链），替代只对 Claude Code 生效的 auditor agent 文件。
   `ctx.inject(['skills'], …)` 惰性注册：宿主没有 skill registry 时静默跳过。
3. **systemPrompt 贡献一段**：`ctx.inject(['systemPrompt'], …)` 注册一个紧凑段落
   （何时用哪个工具 + 顺序纪律）；工具描述里重复的 MUST 话术相应收敛，净上下文不增。
4. **`.claude/**` 分发加开关**：新增 `claudeAssetsEnabled`（默认 `true` = 现状）。
   DSH 有第一方 `@deepseek-ai/dsh-hooks-claude-code` 桥可执行 Claude Code hooks
   （`packages/hooks/hooks-claude-code/README.md:3-7`），但本机 profile 未装载该桥，
   所以这批资产目前只在 Claude Code 里生效——保留分发、README 说清适用面，
   由开关让"不想要 Claude 资产"的项目一键关掉。

## Capabilities

### 修改能力

- `workmate-plugin`：配置定义（native Schemastery 导出 + `claudeAssetsEnabled`）、
  新增"流程指引与审查资产分发"（runtime skill + systemPrompt 段 + Claude 资产开关）。

### 新增能力

- 无新域模型。

## Impact

- 新增依赖：`@deepseek-ai/schemastery@^3.18.2`（runtime，`dependencies` +
  `devDependencies` 声明，`toolchain.json.require` 记录同线）。
- 新增文件：`src/features/guidance/{faces.ts,content.ts,index.ts}`。
- 改动：`src/config.ts`、`src/index.ts`、`src/features/quality/sync.ts`、`src/api.ts`。
- **默认行为不变**：`.claude/**` 仍默认分发、仍不覆盖既有文件；工具名与参数不变。
- 非目标（Step 3）：REST → 原生 `@Remote`/`ctx.remote`、归档编排改原生 `jobs`、
  `presentCall`/`presentResult` 渲染意图。
- 待用户决策：`claudeAssetsEnabled` 的默认值是否翻转为 `false`（涉及 Claude Code
  用户的既有体验）。
