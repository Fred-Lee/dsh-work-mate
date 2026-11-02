# Design — 归档编排的 openspec-archive 步骤核验产物

<!-- files: src/features/archive/orchestrate.ts, src/features/archive/orchestrate.test.ts -->

## D0 事实认定：假绿是怎么发生的（原始实测输出）

2026-10-12 在临时副本（`openspec/changes/*/specs/*/spec.md` 用 `## Requirements`）
实跑 `orchestrateArchive`：

```
ok       tasks             tasks 全部完成；[p] 7/7
ok       swarm             无 swarm 任务（…）
ok       review-gate       无发现；审查通过（harden-test-integrity-author）
ok       openspec-archive  Delta parsing found no operations for test-integrity. Provide ADDED/MODI…
skipped  gitnexus-analyze   disabled by config
ok       status            proposal harden-test-integrity → archived
→ ok = true | changes/ 里还有目录: true
```

四份提案逐一复现，结果一致。再用 `openspec archive` 直接跑，看到 CLI 原话：

```
Delta parsing found no operations for test-integrity. Provide ADDED/MODIFIED/REMOVED/RENAMED sections in change spec.
Aborted. No files were changed.
exit=0
```

**退出码 0**。`execCli`（`orchestrate.ts:116-134`）只在 `error` 非空时 reject，
于是控制流直接走到 `steps.push({ step: 'openspec-archive', status: 'ok', … })`。

边界情形清点（都实测过，决定判据的形状）：

| 情形 | CLI 退出码 | change 目录去向 | 应判 |
| --- | --- | --- | --- |
| delta 合法，归档成功 | 0 | `changes/archive/<date>-<id>/` | ok |
| delta 非法（Aborted） | 0 | 原地留在 `changes/<id>/` | **failed** |
| 变更完全没有 `specs/` 目录 | 0 | 移到 `changes/archive/<date>-<id>/` | ok（规格增量可选，不该被本判据误伤） |
| 上一次已归档，重跑 | 非 0（"not found"） | 已在 `changes/archive/` | skipped（既有语义，保持不变） |
| CLI 真失败（exit != 0） | 非 0 | 原地 | failed（既有语义） |

关键点：**"有没有 specs/ 目录"不是判据**——完全没有 specs 的变更归档是合法的
（实测：无 `specs/` 时 CLI 只打 proposal.md 的 warning，change 目录照样移走）；
判据只能是"这次变更到底有没有从 `changes/<id>/` 移到 `changes/archive/`"。

## D1 判据：复用 `readChangeState()`，不新增解析

`readChangeState(projectRoot, openspecRoot, changeId)`（`src/features/proposal/openspec.ts:180`）
已经同时给出三态：

- `active` —— `changes/<id>/` 还在；
- `archived` —— `changes/archive/` 下有 `*-<id>` 目录；
- `missing` —— 两处都没有。

所以核验就是一句话：**CLI 返回后 `state === 'archived'` 才算这一步真的做成了。**
`orchestrate.ts` 本来就已经 import 了 `readChangeState`（异常分支在用），零新依赖、
零新解析逻辑。注意 `readChangeState` 只统计目录名后缀，不读 `specs/`，所以上表第三行
（无 specs 的合法归档）不会误判。

不采用的两条路：

- **解析 stdout 找 `Aborted`** —— 把成功判据绑在 CLI 的文案上，CLI 改一个字就失效，
  而且这是"读日志猜状态"，不是读产物事实。
- **只用 `findArchivedDir()`** —— 它只回答"archive/ 里有没有"，不回答"changes/ 里是否
  还留着"，无法区分 `archived` 与 `active` 并存（重跑后两份都在）的脏状态。
  `readChangeState` 同时看两边，语义更严格。

## D2 失败怎么表达：沿用既有的 `failed` + `allArchived`

现有代码的形状（`orchestrate.ts:568-616`）已经是"每个 target 一个循环，
`allArchived` 累积，末尾 `if (!allArchived) return { ok: false, … }`"。
所以核验不引入新机制，只是把"退出码 0"这条放行进循环体后，**先核验再决定写 ok 还是 failed**：

- 核验通过 → `ok`，summary 用 CLI 末两行（保持现状的可读性）；
- 核验不通过 → `allArchived = false`、`failed`，summary = CLI 原话 + 一句产物事实
  （"changes/<id>/ 仍在原地"），然后 `continue`（跳过该 target 的 gitnexus 重索引——
  归档都没成，重索引没意义，与既有 `catch` 分支的 `continue` 一致）。

**为什么 summary 要同时带 CLI 原话与产物事实**：CLI 原话是唯一能告诉人"为什么"
（delta 解析失败）的线索，产物事实是唯一能证明"我们真的检查过"的证据。
只留其一都会让下一个人重走一遍这次的排查。

## D3 反证（本条决定"修复是否算数"）

假绿修复的验收不能只是"新用例变绿"——必须证明**旧行为会变红**：

1. 反证用例：构造 delta 非法的变更（`specs/cap/spec.md` 用 `## Requirements` 而非
   `## ADDED Requirements`），跑真实 `openspec` CLI，断言
   `openspec-archive` 步骤 `status === 'failed'` 且 `result.ok === false`。
   把 `orchestrate.ts` 里的核验逻辑注释掉，这条用例必须失败——这是"修复真的在拦东西"
   的唯一证据。
2. 正证用例：同一夹具把段头改成 `## ADDED Requirements`，断言 `ok`、`status === 'ok'`，
   且 `changes/<id>/` 确实被移走。两条用例共用夹具，唯一的差别是那一行段头——
   这样"变红/变绿"只可能来自核验逻辑，不可能来自夹具差异。
3. 幂等用例：先归档成功，再对同一 proposal 跑一次编排，断言第二次是 `skipped`
   而不是 `failed`（重跑语义不能被本次收紧误伤）。

`orchestrate.test.ts` 现有的两处"编排返回 ok"的断言（`:111`、`:591`）用的是
"假装归档但不移动目录"的假 openspec，它们**本来就依赖这次要修掉的假绿**——
按 D3 的反证要求，这两处必须改成真实夹具（或断言改成 `failed`），否则修复无法落地。

## D4 与既有 `catch` 分支的关系

`catch` 分支处理"CLI 抛错"（非 0 退出码）。新分支处理"CLI 说成功但产物没落地"。
两者都落到"产物核验"这同一个事实上，所以实现上把核验放在 `try` 之后、
`catch` 之前的位置最自然：**退出码 0 也走核验，核验不过就转 failed**。
`catch` 分支里那次 `readChangeState` 保持不变（它回答的是"是不是上一次已经归档过了"），
两条路径不会互相污染。

## D5 验收怎么跑

1. 反证先行：写好反证用例 → 跑 → 必须**红**（此时核验逻辑还没有）。
2. 实现核验 → 同一用例变**绿**，且正证/幂等两条也绿。
3. `pnpm typecheck && pnpm test && pnpm build && pnpm verify` 四道门全绿。
4. 真机复核（**需要重启 harness**，属用户动作）：面板对一份故意造坏 spec 的变更点归档，
   应看到 `failed` 与 CLI 原话，提案停在 `archiving`——本变更在重启前只能给出代码级证据。
