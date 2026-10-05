# Add Review Tally (severity + shadow mode)

## Why

审查门现在只有一个布尔：`review.md` 里有没有未勾选的 CRITICAL。playbook 要求的是
**机器可读的分级计数**与**影子期**：

> 「the severity counts that the check run publishes as a **machine-readable tally**」（[P1] Deploy）
> 「**Shadow mode** for all new AI reviewers. New agents post comments for human approval
> until trust is earned.」（[P2] Governance）

前者让门禁能按严重度分级拦截、让度量能统计"审查发现了多少东西"；后者让新审查者
（换了模型/版本的审查 agent）先只报不拦，等建立信任再收严。

## What Changes

1. **解析器扩展**（`review-parser.ts`）：识别带严重度的勾选项
   `- [ ] <CRIT|HIGH|MED|LOW>-<n> <描述>`（原 `CRITICAL 问题` 段的既有写法继续兼容），
   并解析审查者头 `<!-- reviewer: <name>@<version> [shadow] -->`。
2. **tally 派生**：`reviewTally(report)` → 各严重度 total/open、总 open、阻断数、
   审查者版本、是否影子态。
3. **门禁分级**（`Config.reviewBlockingSeverities`，默认 `['CRIT']`）：归档审查门按该
   列表阻断；**影子态审查报告不阻断**（只记录 tally 并在步骤摘要里标注 `shadow`）。
4. **可见性**：状态面返回 `reviewTally`（每个项目），面板审查报告区块显示严重度计数；
   归档步骤摘要带上 `CRIT 0/2, HIGH 1/3` 形式的一行计数。

## Capabilities

### 新增能力

- `review-gate`：分级审查 tally、可按严重度配置的阻断与影子期。

## Impact

- 改动：`review-parser.ts`（严重度与审查者头）、`orchestrate.ts`（门禁分级 + 摘要）、
  `config.ts`（`reviewBlockingSeverities`）、`status.ts`（tally）、客户端展示、
  `workmate-proposal-audit` skill（输出格式）。
- **兼容**：既有 `CRITICAL 问题` 段与 `- [ ] CRIT-n` 写法不变；默认阻断集仍只有 CRIT，
  所以现有提案的归档行为不变。
