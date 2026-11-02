# 归档编排的 openspec-archive 步骤必须核验产物

## Why

`src/features/archive/orchestrate.ts` 的 `openspec-archive` 步骤**只按退出码判定成败**：
`execCli` 不抛异常就写 `status: 'ok'`。而 `openspec archive` 在 delta 解析失败时
**退出码仍然是 0**，只在 stdout 打一行 `Aborted. No files were changed.`。

实测（2026-10-12，临时副本复现，原始输出见 design.md D0）：

- 编排返回 `ok = true`，步骤序列
  `tasks ok → swarm ok → review-gate ok → openspec-archive ok → status ok`；
- `orchestrateArchive` 照样返回到 service，提案被置为 `archived`；
- 而 `openspec/changes/<id>/` **原地没动**，`openspec/specs/<cap>/` 也没生成。

于是面板会显示"归档成功"，实际上什么都没归档，规格库也没有任何变化。这正是
`harden-test-integrity` 要拦的那类假绿——**"退出码 0 不等于事情做成了"**——只不过这次
发生在归档编排自己身上，而它是整条链路的最后一道收口，假绿的代价最大：错误被写成
"已完成"，没有任何后续步骤会再检查一次。

**真实影响范围**：2026-10-12 面板归档的四份提案（`harden-test-integrity` /
`wire-swarm-independent-review` / `harden-archive-gates` / `honest-plan-drift`）当时
全部命中这条路径——它们的 `specs/*/spec.md` 用了 `## Requirements` 而非 delta 段头
（`## ADDED Requirements`），所以四次 `openspec archive` 全部 Aborted，而编排四次都报
`ok`。真正让它们归档成功的是人工发现并修掉那四行 spec 段头，不是编排的判定。

## What Changes

- **编排层核验产物**：`openspec-archive` 步骤在 CLI 返回之后**再读一次产物事实**，
  不以退出码作为成功判据。判据：该变更已从 `changes/<id>/` 移走，且能在
  `changes/archive/<date>-<id>/` 找到（复用已有的 `readChangeState()`）。
- **Aborted 必须变成 failed**：产物没落地时该步骤记 `failed`、整体 `ok = false`、
  提案状态**停在 `archiving`**（既有语义：`service.ts` 在 `!ok` 时记 `gate-failed`
  并返回原状态），并把 CLI 的原话（`Aborted. No files were changed.`）带进 summary，
  让下一个人不必靠猜。
- **重跑语义保持不变**：上一次已经归档成功、这次 CLI 报 "not found" 的情形仍按
  `skipped`（幂等重跑）；核验对"本来就已经在 archive/ 里"同样认作已达成。
- **规格增量**：`archive-gates` 能力新增一条要求，把"归档步骤的成败由产物事实判定"
  写成可验证的语义。

## 非目标

- 不改 `openspec` CLI 本体，也不解析它退出码之外的私有信号（尤其不靠 grep stdout 的
  `Aborted` 字样判成败）。
- 不改八态语义、不改门禁档位默认值、不新增运行时依赖。
- 不顺手修 `specs/*/spec.md` 的段头（那四份已在 2026-10-12 由人工修复并归档）。

## Impact

- 受影响能力：`archive-gates`（新增一条要求）。
- 受影响代码：`src/features/archive/orchestrate.ts`（判定逻辑）、
  `src/features/archive/orchestrate.test.ts`（正证 + 反证）。
- 行为收紧：以前"Aborted 也报 ok"的路径会变成 `ok = false`、提案停在 `archiving`。
  这正是目的；对已经正确归档的路径零影响。
- 运维影响：以后归档失败时面板会显示 `failed` 与 CLI 原话，而不是静默成功。

## 来源 / Provenance

- source: `incident`
- sourceRef: `orchestrate.ts:571-604 实测假绿`
