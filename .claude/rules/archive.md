---
paths:
  - "openspec/**"
  - "**/openspec/**"
---

# 归档流程纪律（WorkMate 编排）

> 提案归档由 WorkMate host 半编排：审查门 → openspec archive --yes →
> gitnexus analyze --force → 状态 archived。Agent 的职责是把入口条件准备好。

强制步骤（顺序不可换）：

1. **验收前置**：确认 `openspec/changes/<id>/tasks.md` 全部勾选（`- [x]`）。
   存在 `- [ ]` 时归档编排会失败即停；确实需要带未完成项归档，由用户在面板
   显式使用 force，不要默认 force。
2. **审查报告**：确认 `openspec/changes/<id>/review.md` 存在且
   `## CRITICAL 问题` 节无未勾选条目。没有报告先运行
   `/agents proposal-auditor`（或提示用户）生成。
3. **提交标记**：本变更的所有提交信息必须含 `[proposal:<id>]`
   （PreToolUse hook 强制拦截，见 `.claude/hooks/check-proposal-tag.sh`）。
4. **触发归档**：调用 `workmate_proposal_archive`（mode=archive）。返回的
   `orchestration.steps` 是编排事实——出现 `failed` 步骤时，按摘要修复后重试
   （幂等：已归档的项目记 skipped），不要绕过编排手跑 openspec archive。
5. **回退路径**：归档后发现问题时用「重新打开」（mode=reopen 或面板按钮），
   change 目录会从 `archive/` 搬回 `changes/`；不要手工 mv 目录。
