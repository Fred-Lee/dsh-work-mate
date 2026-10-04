# Tasks — Add Feedback Loop

- [ ] 1. `store.ts`：`Proposal` 增 `source` / `sourceRef` / `relatesTo` / `provenance`；
      `service.ts` 的 `UpsertProposalInput` 与 `upsert` 同步（显式入参才覆盖）
- [ ] 2. `openspec.ts`：`proposalTemplate` 增「来源 / Provenance」段（Problem /
      Proposed outcome / Affected users and systems / Constraints / Open questions）
- [ ] 3. `events.ts`：事件类型增 `band-breach`（带 metric / tier / current / baseline / sigma）
- [ ] 4. `src/features/metrics/bands.ts`：`DEFAULT_BANDS`、`loadBands`（fail-closed）、
      `evaluateBands`（口径见 design D4）
- [ ] 5. `index.ts`：create 工具新增 `source` / `sourceRef` / `relatesTo` / `notes`；
      注册 `workmate_bands` 工具（第 12 个，`{apply?, windowDays?}`，默认只读）
- [ ] 6. `api.ts`：`GET /workmate/api/bands?apply=&windowDays=`；create 接口透传新字段
- [ ] 7. 测试：bands（默认值 / 覆盖 / 损坏 fail-closed / 样本不足 / 各级 tier / σ=0 边界 /
      direction）、store+service 新字段合并、openspec 模板、事件留痕、index 工具数 12
- [ ] 8. 文档：README 工具表 + REST 表 + 落盘表（`bands.json`）、AGENTS.md 落盘表、
      guidance skill 补一句"来源与基线"
- [ ] 9. 全量验证：typecheck / test / build / verify / openspec validate，真机 `--dump-config`
