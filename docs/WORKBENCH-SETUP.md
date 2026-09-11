# DSH Workbench 环境配置（2026-09-04）

## 插件栈（web profile）

**核心底座 + 能力插件（10 个社区插件，已装入 `~/.dsh/profiles/web`）：**

> 版本权威源：下表与仓库根 [toolchain.json](../toolchain.json) 的 `plugins.community`
> 一一对应，由 `pnpm verify:toolchain` 校验；改版本只改 `toolchain.json`，仅改本表
> 不改清单会被校验判为漂移。

| 插件 | 版本 | 角色 |
|---|---|---|
| dsh-better-sidebar | 0.18.0 | 侧边栏扩展底座：右侧栏（文件/编辑器/终端/Git/浏览器）+ 底部面板，按会话隔离 |
| dsh-plugin-check | 0.1.0 | 插件健康检查（清单协议/patch 格式/构建陷阱），`plugin_check` 工具 |
| dsh-skill-manager | 0.1.3 | Settings 内技能管理面板 |
| @open-agfs/dsh-agfs | 0.1.9 | Agent 文件浏览器（`/dsh-agfs` 命令 + `browse_files`/`read_file` 工具） |
| dsh-outline | 0.1.6 | 实时会话大纲（问题 + Markdown 标题导航） |
| dsh-vision-router | 2.1.2 | 视觉路由（免 key 视觉链 + 像素级视觉工具），composer 出现 Vision 徽标 |
| dsh-mnemon | 0.5.2 | 三层记忆控制平面（runtime/documents/long-term + WebUI + headless 工具） |
| dsh-mcp-adapter | 0.6.3 | MCP 适配器（单一代理工具按需发现，不再全量灌 schema），`/mcp` 命令 |
| dsh-auto-review | 0.10.4 | **第二模型复核**：审批链上只读 reviewer subagent 决定 allow/deny，fail-closed |
| @changfenhuang/dsh-annotation | 1.4.8 | 选中文字→批注→随消息发送 |

**Helmsman 自研 15 个插件**（worktree/memory-topology/knowledge-tolaria/artifacts/board/orchestrator/
adapter-*4/presets/ui-dashboard/ui-diff/ui-workbench/ui-board）同 profile 共存。

## 工作流

1. **侧边栏作为扩展底座**：better-sidebar 提供右侧栏/底部面板容器；文件（agfs）、
   视觉（vision-router）、记忆（mnemon）、MCP（mcp-adapter）按需接入，不占用对话上下文。
2. **重要操作第二模型复核**：dsh-auto-review 在审批链上以只读 reviewer 复核
   `bash`/`write` 类工具调用（toolsPolicy.overrides 已配置），失败即拒绝（fail-closed），
   审计可在会话日志查看。

## 版本对齐要点（重要）

- 本地 harness 为 **0.1.2-alpha.5 源码**；`@deepseek-ai/cordis`（peer）与
  `@deepseek-ai/dsh-tools`（钉版）的约束见根目录 **`toolchain.json`** 的
  `platform`/`kernel` 节（`pnpm.overrides` 已写入 profile package.json）。
  `pnpm verify:toolchain` 会校验本文件版本表与 `toolchain.json` 一致。
- **`@deepseek-ai/dsh-tools` 不能升到 rc 线**：rc 线（自 rc.8 起）引用 `dsh-llm`
  已更名的 `CallId`/`ToolCallId` 导出，会导致 better-sidebar/plugin-check/
  agfs/mcp-adapter/auto-review 导入失败。该损坏配对与症状记录在
  `docs/COMPATIBILITY.md` 的 knownIssues；所有版本只以 `toolchain.json` 为准，
  不要在文档或命令里另立版本。
- 原生依赖（node-pty/koffi/@deepseek-ai/dsh-subprocess-local）已加入
  `pnpm.onlyBuiltDependencies` 白名单并完成构建（better-sidebar 终端面板依赖）。

## 验证记录（2026-09-04，端口 3101 冒烟实例）

- `pnpm dsh --profile web --dump-config` exit=0，全部插件行在树（167 行 insert）。
- 启动日志 **0 error**；boot graph 含 11 个社区 client 模块 + helmsman 全套。
- 浏览器实测：左侧 DSH 侧边栏 + **Memory System**（mnemon）+ 底部 **Terminal** 面板
  （better-sidebar）+ 右侧 **Files** 栏（agfs/better-sidebar）+ composer **Vision** 徽标
  （vision-router）+ 🚀 Helmsman 工作台抽屉，全部同时挂载、互不冲突。

## 侧边栏 Tab 挂载（2026-09-07）

Helmsman 工作台除抽屉外，还注册为 better-sidebar 的一个 Tab（`helmsman:workbench`，
单实例，位于右侧栏「+」菜单，与 Files/Terminal/Memory System 并列）。实现：
client half `inject: ['slots','betterSidebar']` + `ctx.betterSidebar.registerTab`；
面板本体复用抽屉同一组件。文字颜色在 Tab 容器内由 `.hls-body` 自带主题变量修正
（侧边栏容器不提供继承色）。
