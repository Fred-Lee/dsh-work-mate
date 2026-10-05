# Design — Add Proposal Quality Gates

## D1 资产分发：包内嵌 assets，幂等写入目标项目

权威资产在包内 `assets/quality/`（`files` 增加 `assets`，`build.mjs` 拷贝到
`dist/assets/`，运行时从 `import.meta.url` 相对读取——与静态 SPA 同机制）。同步
纪律沿用 Helmsman presets 与 Skill 资产的约定：**目标已存在则永不覆盖**；唯一例外
是 `.claude/settings.json`——hooks 采用合并写入（按 hook 命令字符串去重，用户已有
hooks 原样保留）。

`Config.qualitySyncEnabled`（默认 true）总开关。同步动作挂在创建提案流程里（目标
项目根可解析时）；无 projectRoot 时跳过并在返回值 note 说明。

## D2 审查智能与门禁的边界（对指令的关键修正）

指令要求「归档前调用 proposal-auditor subagent」。host 半是 Node 进程，**无法调用
Claude Code 的 subagent**——那是会话内的机制。按「寄生而非替代」切分：

- **审查智能**（读提案、查 GitNexus、写报告）= Claude Code 层的
  `proposal-auditor` subagent，由用户/Agent 在会话中运行，产出
  `openspec/changes/<id>/review.md`。
- **确定性门禁**（WorkMate host）：归档编排前置检查 review.md 的**结构化信号**——
  存在性 + CRITICAL 条目的解决状态。这就是验收谓词纪律（结构化信号，不调 AI）。

模板因此约定 review.md 的机器可读形状：`## CRITICAL 问题` 节内每条为
`- [ ] CRIT-n 描述`（未解决）或 `- [x] CRIT-n 描述`（已解决）。

## D3 提交拦截用 PreToolUse（对指令的关键修正）

指令要求 PostToolUse hook「拒绝提交」——PostToolUse 在工具执行**之后**触发，提交
已经发生，拦不住。Claude Code 的阻断点是 **PreToolUse**（matcher 匹配 + hook 返回
exit 2 / JSON decision 阻断工具调用）。落地：

```jsonc
// 目标项目 .claude/settings.json（合并写入，去重键 = command 全文）
{ "hooks": { "PreToolUse": [ {
  "matcher": "Bash(git commit*)",
  "hooks": [ { "type": "command",
    "command": "bash .claude/hooks/check-proposal-tag.sh" } ] } ] } }
```

脚本从 stdin 读 JSON（`tool_input.command`），不含 `[proposal:` 则 exit 2 并输出
提示（Claude Code 把 stderr 回给模型）。版本要求：hooks 机制需 Claude Code
`>= 1.0.60`（2025-07 引入 PreToolUse JSON decision）；rules 目录与 agents 目录为
更新机制，资产文件头标注「以官方文档为准」。

## D4 review.md 解析器（host）

`src/features/quality/review-parser.ts`：按模板的四节标题切分（`## 确认项` /
`## 疑问项` / `## 建议补充项` / `## CRITICAL 问题`），行级提取条目；CRITICAL 条目
的 checkbox 状态即解决状态。节缺失 = 空数组（模板引导 AI 全部输出，但不强制）。
解析器是纯函数，单测覆盖。

## D5 状态机：reviewing 的位置

`draft → reviewing → executing`，即审查是提案准备（draft）与执行之间的门。流转：
`POST /:id/review`（draft→reviewing）、`POST /:id/approve`（reviewing→executing）、
`POST /:id/unreview`（reviewing→draft，回退）。`start` 直通保留（无 review.md 的
轻量提案仍可用，兼容 M2 契约）；归档审查门独立于该状态（executing 的提案照样过门）。

## D6 schema fork 的两份关系

`openspec/schemas/workmate-review/`（WorkMate 仓库内，fork 产物）是**开发副本**
（吃狗粮：自身 config.yaml 切 schema）；**分发副本**在 `assets/quality/openspec/`，
两者内容一致，CI 无需强制（fork 是一次性动作，资产以 assets 为准写进同步器）。
