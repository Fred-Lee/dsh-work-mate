# Tasks — 归档门禁加固

> 范围声明用行内 `<!-- writes: … -->`（swarm 装批 + `workmate_plan_drift` 都读它）。
> 同一文件出现在多行时**不得并行**（writes 相交）。
> 本变更不新增运行时依赖，不改八态语义。

- [ ] 1. 规格增量 `specs/archive-gates/spec.md`：三条要求 —— ① `force` 归档 SHALL 只由非 agent actor（或显式 `allowAgentForceArchive`）执行，且每次执行 SHALL 记 `approval(gate:'force-archive')`；② 归档门 SHALL 按 `reviewerIndependence` 判定审查者是否独立于执行者，`undetermined` SHALL NOT 在 `block` 档阻断；③ 归档门 SHALL 校验 review.md 的反引号引用（存在性 + 行号范围），GitNexus 类结论 SHALL 标注为不可机检 <!-- writes: openspec/changes/harden-archive-gates/specs/** -->

- [ ] 2. 配置面：`src/config.ts` 新增 `allowAgentForceArchive`（默认 `false`）、`reviewerIndependence`（`off|warn|block`，默认 `warn`）、`reviewEvidenceGate`（`off|warn|block`，默认 `warn`）；**interface 与运行时 Schemastery schema 两份同步**，并同步 `CONFIG_DEFAULTS` <!-- writes: src/config.ts -->

- [ ] 3. 引用校验纯函数 `src/features/quality/citations.ts`：抽取反引号引用（`file:line` / `file:12-30` / `file#L42` / 裸路径），GitNexus 类条目归为 `not-machine-checkable`；带一个可注入的 `statFile` 探针便于单测（默认读真实文件系统），行号超范围与文件缺失分别成 verdict <!-- writes: src/features/quality/citations.ts -->

- [ ] 4. 审查者独立性判定 `src/features/quality/reviewer-independence.ts`：输入 reviewer 自报 + 执行者身份集合（`{name, email}`），输出 `independent | same-as-author | missing | undetermined`；判定为纯函数，git 采集放在 archive 层 <!-- writes: src/features/quality/reviewer-independence.ts -->

- [ ] 5. 归档编排接线 `src/features/archive/orchestrate.ts`：新增 `reviewerIndependence`、`reviewEvidenceGate`、`executorIdentities` 选项；审查门在原有 CRITICAL 判定之后追加两条子判定并产出 `review-independent` / `review-evidence` step（三档语义见 design D2/D3）；`forced` 字段真正赋值（reviewGate/tasksGate 被跳过即为 true） <!-- writes: src/features/archive/orchestrate.ts -->

- [ ] 6. 归档服务 `src/features/archive/service.ts`：新增 `assertForceAllowed`（agent 无权，除非 `allowAgentForceArchive`）+ force 通过后写 `approval(gate:'force-archive')`；把 `forced` 透传到返回值；`deps` 增加 `allowAgentForceArchive` / `reviewerIndependence` / `reviewEvidenceGate` <!-- writes: src/features/archive/service.ts -->

- [ ] 7. 宿主接线 `src/index.ts`：工具 schema 的 `force` 描述改为"人工运维入口，agent 调用会被拒，除非 `allowAgentForceArchive`"；把三个新配置透传给 lifecycle；`workmate_proposal_status` 增加 `forcedArchive` 投影（读事件流里最近一条 `force-archive` 审批） <!-- writes: src/index.ts -->

- [ ] 8. 状态投影 `src/features/proposal/status.ts`：`ProposalStatus` 增加 `forcedArchive?: { at: string; actor: string; rationale?: string }`，由调用方传入的最近 force 审批填充；`executorIdentities` 采集（`git log --format=%an|%ae` 带标记提交的 author）挂在 archive 层而不是 status 层 <!-- writes: src/features/proposal/status.ts -->

- [ ] 9. 文档与技能：`src/features/guidance/content.ts` 写出 `force` 新语义与两个新门；`AGENTS.md` 补 `planDriftGate` / `reviewerIndependence` / `reviewEvidenceGate` 的开启方式；`README.md` 同步配置表 <!-- writes: src/features/guidance/content.ts, AGENTS.md, README.md -->

- [ ] 10. 单测：`src/features/quality/citations.test.ts`（引用抽取边界、缺失文件、越界行、GitNexus 跳过）、`src/features/quality/reviewer-independence.test.ts`（四种 verdict、大小写与 email 匹配）、`src/features/archive/gates.test.ts`（三档 × 四种 verdict 的真值表、force 对 agent 拒绝、force 对 human 留痕、`forced` 赋值） <!-- writes: src/features/quality/citations.test.ts, src/features/quality/reviewer-independence.test.ts, src/features/archive/gates.test.ts -->

- [ ] 11. 回归与收口：`pnpm typecheck && pnpm test`（不得低于基线 348 用例）；`pnpm build && pnpm verify`；`workmate_plan_drift` 自查声明与实际一致；把"验了什么/怎么验的/明确没验什么"写进 `review.md` <!-- writes: openspec/changes/harden-archive-gates/review.md -->

## 验收命令（每步都跑，不以退出码判定）

```bash
pnpm typecheck && pnpm test
pnpm exec vitest run src/features/archive src/features/quality
pnpm build && pnpm verify
```

## 完成标记纪律

`[x]` 只表示"这一步被认为完成了"，不等于验收通过。第 11 项必须给出可证伪结论：
测试数字（基线 40 文件 / 348 用例）、新增用例数、明确未覆盖的分支（如真实 git 多 author 场景只做单测）。
