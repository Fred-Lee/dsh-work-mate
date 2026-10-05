# Design — Add Swarm Parallel

## D1 任务从工件派生，不新增实体层

任务就是 `tasks.md` 里的一行（`- [ ] 2. 拆分计费模块 <!-- writes: src/billing/** -->`）。
好处：任务与交付工件天然一致，`[proposal:<id>]` 提交标记、review、归档验验收全部复用；
坏处：`writes` 只能靠行内注释表达——用 `<!-- writes: ... -->` 这一既有注释风格，缺失即
视为"未声明范围"（未声明不参与防踩踏，但会在计划里标 `writes: []` 提醒）。

## D2 装批规则：相交即不同批，未声明不阻塞

- 两个任务的 `writes` 有任何 scope 前缀重叠 → **不得同批**（严格串行）。
- 未声明 `writes` 的任务：不与他人判冲突（保守地"不知道就别拦"），但在计划输出里
  标出来，让调用方自己决定要不要补声明。
- 装批是贪心 first-fit：按任务顺序放进第一个还能放且不冲突的批，批内上限 `maxParallel`。
  贪心足够——任务数是个位数到几十，最优装箱没有收益。

## D3 分支与目录命名带 `--task`，与提案级载体并存

提案级 worktree 是 `<root>/.workmates/<proposal>`（分支 `feature/<proposal>`）；
任务级是 `<root>/.workmates/<proposal>--<task>`（分支 `feature/<proposal>--<task>`）。
任务分支**基于提案的 implementation 分支**创建，因此合回是"同族合并"，冲突面只在本提案
改过的文件里，不会牵扯 main。

## D4 合并冲突是裁决，不是机械操作

`git merge --no-ff` 失败 → `git merge --abort` 回到干净态，把
`git diff --name-only --diff-filter=U` 的冲突文件列表返回，任务标记 `failed` + note。
插件**不自动解决冲突**：那是 [P1] 里明确要人（或具名 agent）裁决的点；插件只保证
状态可重试（重试时先 abort 再 merge）。

## D5 归档谓词与 swarm 共用一道门

验收谓词本来检查 tasks.md 全勾选；现在再加一条：存在未 `merged` 的 swarm 任务即失败，
摘要列出 `[taskId] status`。同一道门、同一个 `force` 逃生阀——"任务没合回来"和
"任务没勾选"是同一类事实：还不能归档。
