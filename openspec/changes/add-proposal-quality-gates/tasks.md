# Tasks — Add Proposal Quality Gates

- [x] 1. OpenSpec 层：schema workmate-review 插入 review 工件 + review.md 模板 +
      自身 config.yaml 切换；assets/quality/openspec/config.default.yaml
- [x] 2. Claude 层资产：rules×2、proposal-auditor.md、check-proposal-tag.sh、
      settings.hooks.json 片段（assets/quality/claude/）
- [x] 3. 构建链：assets 拷贝进 dist（build.mjs + files）
- [x] 4. host：src/features/quality/{sync.ts,review-parser.ts}（幂等同步 + 解析器）
- [x] 5. host：状态机 reviewing（review/approve/unreview）+ 归档审查门 + REST +
      工具 mode 扩展 + Config.qualitySyncEnabled
- [x] 6. client：详情区审查报告小节（红/黄/常规）+ 重新审查按钮
- [x] 7. 测试：解析器、同步幂等、状态机、审查门、面板渲染
- [x] 8. 全量验证 + 真机验收（资产同步、hook 拦截、审查门端到端）
      - 资产同步：新项目一次写入 10 项；用户已改 config/rules 不被覆盖；
        settings.json hooks 合并去重；运行时资产路径 bug（多上跳一层）真机抓出修复
      - hook：无 [proposal:] 标记 exit 2 带提示、带标记放行
      - 审查门三态：无报告阻断 / 未解决 CRITICAL 阻断（列条目）/ 已解决放行
      - 归档后报告回退读取：archived 卡片仍可展示审查报告
