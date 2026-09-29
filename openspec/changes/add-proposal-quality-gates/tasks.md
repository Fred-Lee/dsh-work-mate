# Tasks — Add Proposal Quality Gates

- [ ] 1. OpenSpec 层：schema workmate-review 插入 review 工件 + review.md 模板 +
      自身 config.yaml 切换；assets/quality/openspec/config.default.yaml
- [ ] 2. Claude 层资产：rules×2、proposal-auditor.md、check-proposal-tag.sh、
      settings.hooks.json 片段（assets/quality/claude/）
- [ ] 3. 构建链：assets 拷贝进 dist（build.mjs + files）
- [ ] 4. host：src/features/quality/{sync.ts,review-parser.ts}（幂等同步 + 解析器）
- [ ] 5. host：状态机 reviewing（review/approve/unreview）+ 归档审查门 + REST +
      工具 mode 扩展 + Config.qualitySyncEnabled
- [ ] 6. client：详情区审查报告小节（红/黄/常规）+ 重新审查按钮
- [ ] 7. 测试：解析器、同步幂等、状态机、审查门、面板渲染
- [ ] 8. 全量验证 + 真机验收（资产同步、hook 拦截、审查门端到端）
