# Tasks — Add Decision Layer

- [x] 1. `types.ts`：题目/答案/provider/outcome 类型
- [x] 2. `rules.ts`：确定性兜底 provider（矛盾检测走 abstain；分级/注入用关键词规则）
- [x] 3. `agent.ts`：host `ctx.llm` 强制单工具调用 + 多采样一致率
- [x] 4. `service.ts`：provider 链、阈值动作、降级与理由
- [x] 5. `events.ts` + `config.ts`：`decision` 事件与 `Config.decision`
- [x] 6. `index.ts`：实例化 + `workmate_proposal_decide` 消费（矛盾即要求 supersedes）
- [x] 7. 测试：rules、agent（假 llm：单次/多采样/答不出）、service（阈值/降级）、
      decide 工具（矛盾拒绝 / 带 supersedes 通过 / 未启用时行为不变）
- [x] 8. 文档：README（判断层一节）+ guidance（decide 的纪律）+ AGENTS 里程碑
- [x] 9. 验证：typecheck / test / build / verify + 真机
