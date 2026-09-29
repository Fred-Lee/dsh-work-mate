# Add Proposal Quality Gates

## Why

真机使用 Claude Code + Qwen 3.8 Flash 时，提案准备阶段反复对话确认细节、每轮审核
又发现新问题——根因是 AI 只有对话式约束、缺少确定性规则。把「对话式对齐」改为
「结构化预检」：OpenSpec 层管提案质量（约束注入 + 审查门），Claude Code 层管执行
纪律（rules + hooks + subagent），WorkMate 只做确定性门禁与资产分发。

## What Changes

1. **自定义 schema**（`openspec schema fork spec-driven workmate-review`，CLI 1.3.1
   原生支持）：在 design 与 tasks 之间插入 `review` 工件（交叉一致性审查），
   `tasks.requires` 追加 `review`——审查通过才生成任务。WorkMate 自身 config.yaml
   切换到该 schema（吃狗粮）。
2. **目标项目资产同步**（host 半，幂等不覆盖）：创建提案时向目标项目写入/补齐——
   `openspec/config.yaml`（默认含 per-artifact 硬约束：消费方枚举、历史提案关联、
   Given/When/Then、GitNexus 同步标注、模块复用、并发安全、writes 声明、归档验证）
   与 `openspec/schemas/workmate-review/`（schema + 全部模板）。
3. **Claude Code 层模板**（同样同步到目标项目 `.claude/`）：`rules/knowledge-bridge.md`
   与 `rules/archive.md`（frontmatter `paths` 限定）、`agents/proposal-auditor.md`
   （审查 subagent）、`hooks/check-proposal-tag.sh` + `settings.json` 的
   **PreToolUse** hook（见 design D3 修正：PostToolUse 拦不住提交）。
4. **状态机**：新增 `reviewing`（draft → reviewing → executing）；`start` 直通路径
   保留（兼容）。
5. **归档审查门**：编排前置检查每个关联项目的 `changes/<id>/review.md`——缺失或
   存在未解决 CRITICAL（模板用 checkbox 表达解决状态）则失败即停；`force` 可跳过。
   host 只验**结构化产物**，审查智能在 Claude Code 层（proposal-auditor）——host
   无法调用 Claude Code subagent（design D2 决策）。
6. **面板**：详情区新增「审查报告」小节（解析 review.md：CRITICAL 红 / 疑问黄 /
   确认绿）+「重新审查」按钮（重读报告，并提示在会话中运行 auditor）。

## Capabilities

### 新增能力

- `proposal-quality-gates`：目标项目资产同步、review 工件解析、状态机 reviewing、
  归档审查门、面板审查报告。

## Impact

- 新增 `assets/quality/`（openspec 模板 + claude 模板，构建时拷入 dist）；
  新增 `src/features/quality/`（同步器 + review 解析器）。
- `config.ts` 加 `qualitySyncEnabled`；`service.ts` 状态机 + `reviewing`；
  `orchestrate.ts` 前置审查门；REST 两个端点；工具 mode 扩展；App.tsx 详情区。
- 依赖：openspec CLI `>=1.3.1`（schema fork 实验特性）；Claude Code rules/hooks/
  agents（版本要求在资产文件内标注）。
