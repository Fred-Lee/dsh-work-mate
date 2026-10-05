# Add Bands Watch (deterministic Maintain trigger)

## Why

playbook 的 Maintain 阶段要求**确定性检测**、只在越界后才叫模型：

> 「The script is version controlled and unit tested, and **detection stays entirely
> deterministic, with no model involved**.」…「Claude is invoked once a band is breached,
> and the tier sets what it may do.」（[P1] Maintain）

WorkMate 现在只有"人在会话里想起来才跑"的 `workmate_bands`。缺一个**能被任何调度器调用**
的确定性入口，让控制带检测脱离"想起来"。

**关于宿主调度**：DSH 的 `schedule` 服务是**会话绑定的提醒投递**
（`ScheduleCreateRequest` 需要 sessionId，投递的是 prompt），插件在启动期没有会话可绑；
而工具执行面（`ToolExec`）只暴露 `agent` 与 `signal`，不保证有 sessionId。所以本变更改走
**确定性脚本 + REST**：任何外部调度器（cron / launchd / CI / DSH 的 schedule UI）都能拉起它，
这也更贴 [P1] 的原意（脚本可版本化、可单测、无模型）。

## What Changes

1. **共享执行器**：把 `workmate_bands` 工具里的评测 + 留痕 + 可选开提案抽成
   `runBandsCheck(deps, { apply, windowDays })`，工具与 REST 共用一套口径。
2. **`POST /workmate/api/bands`**：`{ apply?, windowDays? }` —— 越界留痕（`band-breach`
   事件）与 `apply:true` 时开 `metric-regression` 草稿提案；`GET` 仍是只读。
3. **`scripts/bands-watch.mjs`**：确定性检测脚本。拉 `GET /workmate/api/bands`，按
   `--fail-on`（默认 `propose`）决定退出码；`--apply` 时再 POST 让 3σ 开提案。
   纯函数部分（摘要渲染、退出码判定）可单测。
4. **文档**：README 增「Maintain 回环：把控制带接到任何调度器」，给 cron / launchd 示例，
   并明确写清"宿主 schedule 是会话绑定的，所以这里用脚本"。

## Capabilities

### 新增能力

- `bands-watch`：控制带的确定性对外入口（REST POST + 可调度脚本）。

## Impact

- 改动：`src/api.ts`（POST/共享执行器）、`src/index.ts`（工具改用共享执行器）、
  新增 `scripts/bands-watch.mjs` 与其用例、README。
