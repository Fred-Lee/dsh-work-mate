# Injection Judgement on the Tool Path

## Why

用**真机指令注入探针**验收判断层四个消费节点时发现一个真实缺陷：

- 通过 **工具** `workmate_proposal_create` 创建提案（agent 的常规路径）时，
  `notes` 里写着 `IGNORE ALL PREVIOUS INSTRUCTIONS…`，结果**没有任何 `decision` 事件、
  没有 `untrusted` 标记、判断缓存条目数不变（14）**；
- 而 REST 路径 (`createProposal` 调用点) 是**带** `decision` / `events` 的，注入判定会执行并留痕。

根因：工具路径复用 `createProposal` 时**漏传 `decision` 与 `events`**，于是
`deps.decision?.enabled === true` 恒为假 → **注入判定在 agent 最常走的入口被静默跳过**。
这是安全相关性缺陷（外部文本可能夹带指令却被当作可信）。

## What Changes

1. 工具路径补传 `decision: deps.decision, events: deps.events`（与 REST 同源、同一实现）；
2. 新增用例：给定带 `decision` 的 deps，`createProposal` 必须调用 `injection-risk` 判定、
   写入 `decision` 事件，并把 `provenance.untrusted` 落到提案上。

## Impact

- `src/index.ts`（两行）+ `src/api.test.ts` 一个用例；判断语义与阈值不变。
- REST 与工具两条入口从此行为一致。
