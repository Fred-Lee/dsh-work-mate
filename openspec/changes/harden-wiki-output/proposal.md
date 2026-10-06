# Harden Wiki Output (report partial generation honestly)

## Why

第一次真机跑 `gitnexus wiki`（对 `internal-homework`）就暴露了一个真实缺口：**生成中途失败时
产物是"半份"的**——3 分钟里写出了 34 个页面，随后 LLM 端点熔断中断，退出信息里只有一行
`Error: LLM endpoint circuit open`，而 CLI **没有** `index.html`、也没有 `meta.json`。
只看"命令跑过了"会得出"wiki 生成好了"的错误结论（本次实测：13 个模块只出 7 个）。

WorkMate 的职责不是替 GitNexus 修熔断，而是**如实报告产物是否完整**——这正是本项目一以贯之的
纪律：完成标记不等于成功证明。

## What Changes

`gitnexusWiki()` 在调用结束后**读产物目录**做事实核验：
- `pages`：已写出的模块页数（`.md` 计数）；
- `complete`：`index.html` 是否存在（GitNexus 在收尾阶段才写阅读器与 meta，缺它就是没跑完）；
- 若 CLI 报成功但 `complete === false`，`note` 明确写"生成中断：N 页、缺 index.html，
  重跑可补齐"；若 CLI 报错，`note` 保留原文并附带同样的产物事实。

工具 `workmate_wiki_generate` 与 `POST /api/wiki` 一并回传 `pages` / `complete`。

## Capabilities

### 修改的能力

- `wiki-generation`：产物完整性核验（`pages` / `complete`）与中断说明。

## Impact

- 改动：`knowledge-bridge/gitnexus.ts`、`src/index.ts`（工具回传字段）、`src/api.ts`、
  README（快速命令一节补 `complete` 语义）。
- 不改变成功路径的行为；失败/中断路径从"一行错误"变成"错误 + 产物事实 + 下一步建议"。
