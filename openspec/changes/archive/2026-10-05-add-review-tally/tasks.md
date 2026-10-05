# Tasks — Add Review Tally

- [x] 1. `review-parser.ts`：严重度标签 + 审查者头（`reviewer` / `shadow`）+ `reviewTally`
- [x] 2. `config.ts`：`reviewBlockingSeverities`（默认 `['CRIT']`）
- [x] 3. `orchestrate.ts`：门禁按 tally 分级、影子态放行、摘要带计数
- [x] 4. `status.ts`：状态面返回 `reviewTally`
- [x] 5. 客户端：审查报告区块显示严重度计数
- [x] 6. 测试：解析（标签/头/兼容）、tally、门禁（CRIT 阻断 / HIGH 配置后阻断 / 影子放行）
- [x] 7. 文档：README 配置表 + skill 输出格式（`workmate-proposal-audit`）
- [x] 8. 验证：typecheck / test / build / verify + 真机
