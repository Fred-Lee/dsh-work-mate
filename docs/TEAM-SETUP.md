# 团队编排部署与首次运行

> 适用：`autonomous-agent-team` 之后。团队 Run 是提案之上的执行层，不替代八态生命周期。

## 1. 角色 preset（必须）

`teamRequireRolePresets=true`（默认）时，没有匹配的 agent preset 会**拒绝派发**。
agent preset 不是 `$DSH_HOME/.agent-presets/` 旧目录，而是 profile 里安装的
`@deepseek-ai/dsh-agent-preset` bundle（如 Web 自带的 `standard` / `minimal` / `ptc`）。

读角色（需求/方案评估、reviewer）必须映射到不含写工具的 readonly preset；
开发/测试/协调角色映射到 workspace-write preset。Web 自带 `minimal`（无 write/edit）
与 `standard`（workspace-write）可直接使用：

```yaml
# cordis.patch.yml（workmate 条目）
teamReadonlyPreset: minimal
teamWorkspacePreset: standard
```

如果 `minimal` 不够严格（它仍带 shell），可自建只读 bundle（目录里两个文件，安装后需重启宿主）：

```yaml
# review-preset/cordis.patch.yml
- insert:
    - id: preset-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review
        name: Review
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: 你只读审查，不修改代码。
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
```

```json
// review-preset/package.json
{ "name": "@local/dsh-review-preset", "version": "1.0.0", "private": true,
  "type": "module", "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

安装后 `list_plugins` 应出现新增 preset 且已激活；否则不要派发。

> **配置生效需要重启 harness**：`cordis.patch.yml` 的改动不会热加载。
> 本机入口 `~/.dsh/harness-restart.sh`；重启后再跑真实 Run。

## 2. 准备工件

```
workmate_team_prepare(proposalId, projectRoot?)
```

- 从 `proposal.md` 派生 REQ、从 `design.md` 派生 PLAN、从 `tasks.md` 派生 TASKS.json；
- 不覆盖已有文件；`derived: true`，需人复核后再 G2；
- 多 target 提案必须在 `tasks.md` 每条任务写 `<!-- project: ... -->`，否则拒绝派生；
- 建议同时写 `<!-- role: ... -->` 与 `<!-- writes: ... -->`；缺 writes 会警告，worker 改动会被判未声明写域。

## 3. 创建并运行

```
workmate_team_plan(proposalId, template='requirement-full', start=false)  # 建 planned Run + 波次
# 方案确认（planHash 需人工 approve，高风险/多仓强制）
workmate_team_run(runId)                                                   # 真正派发
workmate_team_status(runId) / workmate_team_inbox(runId)
workmate_team_answer(runId, messageId, reply)                              # 回答 QUESTION/ESCALATION
```

入口只允许提案 `ready/implementing/merging`；`archiving` 后不能新建 Run。

## 4. 证据与门禁

Run 结束写 `SUMMARY.md`；测试/审查角色分别写 `TEST.md`/`TEAM-REVIEW.md`。
`TEAM-REVIEW.md` 首行必须是 `<!-- reviewer: <本 Run 的 reviewer dispatch id> -->`，
否则团队证据门阻断归档。归档门要求：最近 Run `succeeded`、TASKS.json 在、
TEST/TEAM-REVIEW/SUMMARY 齐全、reviewer dispatch 与实现者身份不相交。

## 5. 已知限制

- Host 只在给出 usage 时累计 token；缺失显示「未计量」，300k 预算不能硬保证；
- 单波 30 分钟硬超时，超时会 cancel worker 并 abort Run；
- 合并发生在 `merging→archiving`，项目主检出必须在 base 分支且干净（未跟踪 SUMMARY.md 除外）；
- 真实两仓端到端 Run 仍需要人工在装有 preset 的 profile 里执行并截图。

## 6. 首次验收清单

- [ ] `pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿
- [ ] profile 配好 readonly/workspace preset，`list_plugins` 激活
- [ ] 一个两仓提案：`prepare → plan → run` 成功，Run `succeeded`
- [ ] `TEST.md` / `TEAM-REVIEW.md` / `SUMMARY.md` 生成且 marker 匹配
- [ ] G2（approvePlan）与 G5（merge approval）由人完成
- [ ] `merging→archiving` 真实合并成功，归档编排产物事实正确
