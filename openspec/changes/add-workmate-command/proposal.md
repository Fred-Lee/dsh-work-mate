# Add the `/workmate` Slash Command

## Why

用户问"是否 `/workmate` 有这样的指令"。此前**没有**：WorkMate 只提供工具（`workmate_*`）、
REST（`/workmate/api/*`）与独立页（`/workmate/`）。而在对话里说"整理一下 X 的 wiki"，
**选哪个工具由模型决定**——它可能绕开我们的工具直接跑 `gitnexus wiki`，于是代理没起、
key 拿不到、产物也不核验。

宿主其实提供了插件注册"人类命令"的能力：`@deepseek-ai/dsh-commands`（`ctx.commands`，
经 `@deepseek-ai/dsh-base` 已在 web profile 装载）。其 `handler` 的定义就是
**"Execute against the receiving agent without sending the command to the model"**——
这正是把"确定性入口"补上的那块拼图。

## What Changes

注册一条斜杠命令 **`/workmate`**，子命令写在参数里（不经过模型）：

| 输入 | 行为 |
|---|---|
| `/workmate` 或 `/workmate help` | 打印用法（成功结果，直接由 UI 渲染） |
| `/workmate status <绝对路径>` | 只读：索引新鲜度 + wiki 产物（`pages` / `complete` / `index.html` 大小），不调 LLM |
| `/workmate wiki <绝对路径> [--force] [--reanalyze] [--lang <lang>]` | 按需保证 SSE 代理 → 可选重索引 → 生成 wiki → 按 `complete`/`pages` 汇报产物路径 |

- 参数解析是**纯函数**（可单测）；路径必须是存在的绝对目录。
- 结果用 `CommandResult`：跑完/命中用 `success` + 文本；半份产物或缺凭据用 `error` + 原因，
  让 UI 直接显示而不是让人猜。
- 命令注册走 `ctx.inject(['commands'])` + `scope.effect(...)`，与 `skills`/`systemPrompt`
  同一套惰性装配纪律：没有该服务的 profile 少一块能力，插件仍 ACTIVE。

## Capabilities

### 新增能力

- `workmate-command`：`/workmate` 斜杠命令（help / status / wiki）。

## Impact

- 新增 `src/features/command/{parse,definition}.ts`、`faces.ts` 里的最小 `CommandFace`、
  `index.ts` 注册；README 命令表与 §0 入口、常驻系统提示同步说明；AGENTS 里程碑。
- **确定性**：该路径不经过模型选择，不怕"模型绕开工具直接跑 CLI"。
- 需要重启 harness 才生效（host 侧注册）。
