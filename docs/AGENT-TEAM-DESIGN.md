# 自主 Agent 团队设计：需求/方案评估 → 前后端实现 → 集成测试（2026-10-19）

> 目标：在 WorkMate 里组建一支可复用的 Agent 团队，技术方案确认后**自主推进**到可验收；人只把关产品级/范围级决策与合并/归档。
>
> 参考：DeepSeekBot / DS Bot（长期角色 Bot 与群聊协作）、`@yangdcm/dsh-expert-team`（12 角色 9 阶段门控）、Orca orchestration（Run/Task/Dispatch、DAG、门禁、协调循环）、WorkDSH（项目配置修订、任务=原生会话、工作台契约）。

## 0. 结论

1. **团队不是「一个 agent 串行扮演五个角色」**，而是：**一个协调器 + 五个角色 worker + 一个独立审查者**，每个 worker 是独立的原生 DSH Session，cwd 绑定到对应仓库的 worktree。
2. **自主推进的边界**：需求评估与技术方案评估是「人参与的门」；方案确认后进入自主执行波次（前后端并行 → 集成测试 → 独立审查），只有阻塞提问、冲突、失败重试耗尽才回到人。
3. **复用的是模型不是代码**：DeepSeekBot 给角色/长期会话/收件箱语义；`dsh-expert-team` 给角色表、9 阶段与硬门/确认门；Orca 给 Task/Dispatch/DAG/worker_done/escalation 的编排原语；WorkDSH 给项目修订、任务=原生会话、有界内容区与数据边界。
4. **不要自建 agent runtime / 聊天 / IM**：worker 用宿主 Session/Subagent，消息与会话事实归宿主；WorkMate 只做编排、工件、门禁、证据与审计。

## 1. 角色团队

| 角色 | 职责 | 产出 | 权限边界 |
|---|---|---|---|
| **协调器** `coordinator` | 建 Run、拆 DAG、派发波次、收件箱、汇总、门禁推进 | `RUN.log.md` / `events` | 不写业务代码；不代替人批准 merging/archiving |
| **需求评估** `requirement-evaluator` | 澄清目标、边界、禁止项、验收口径；识别歧义与缺失信息 | `REQ.md`（含「边界与禁止项」「验收判据」） | 只读代码；不写实现 |
| **技术方案评估** `solution-evaluator` | 方案/模块拆分/依赖 DAG/风险/回滚；映射到多仓 targets | `PLAN.md` + `TASKS.json` | 只读代码；不写实现 |
| **前端开发** `frontend-dev` | 按 target 的仓库与分支实现前端改动 | 提交 + `task` 证据 | 只改声明的前端写域 |
| **后端开发** `backend-dev` | 按 target 的仓库与分支实现后端/服务改动 | 提交 + `task` 证据 | 只改声明的后端写域 |
| **集成测试** `integration-tester` | 跨仓契约、端到端、回归；复现失败并给证据 | `TEST.md` | 只读 + 测试脚本；不改业务代码 |
| **独立审查** `reviewer` | 独立评审实现与方案一致性；不能审自己写的 | `TEAM-REVIEW.md`（severity/file/line/status） | 只读；与实现者身份不同 |

> 角色可以按提案模板裁剪：纯调研不需要前后端；纯 bug 修复可以跳过需求评估或方案评估（但独立审查仍需要）。

## 2. 流程与门禁

```text
intake（用户一句话 / 提案）
  └─ G0 需求评估      requirement-evaluator → REQ.md
       └─ G1 方案评估  solution-evaluator → PLAN.md + TASKS.json（DAG）
            └─ G2 方案硬门（reviewer + 人确认）   ← 默认必须过人；可通过配置收紧/放宽
                 └─ 自主波次：backend / frontend（按 DAG 并行）
                      └─ G3 集成测试（integration-tester）→ TEST.md
                           └─ G4 独立审查（reviewer）→ TEAM-REVIEW.md
                                └─ G5 合并/归档（人批准，沿用现有 approval-gate）
```

- **硬门**：G2 要求 `REQ.md` 有边界/禁止项、`PLAN.md` 有目标矩阵/回滚、`TASKS.json` 每项有 owner/writes/acceptance；缺失即不进入实现。
- **确认门**：G2 默认要人点一次「同意方案」，之后进入自主执行；配置可改为按风险自动（高风险仍强制人确认）。
- **G5 不变**：`merging` / `archiving` 仍由人批准（WorkMate 现有分离职责），协调器只能推进到门前。

## 3. 编排模型（借鉴 Orca）

| Orca 概念 | WorkMate 映射 | 说明 |
|---|---|---|
| **Run** | 一次提案实现运行 `runId` | 持久命名空间 + 协调器收件箱 |
| **Task** | 一个角色 × 一个 target 的工作项 | 来自 `TASKS.json`；必须有 owner/writes/acceptance |
| **Dispatch** | 一次 Task 尝试 | 一个原生 Session；失败重试是新 Dispatch |
| **wave / DAG** | 按 `depends_on` 分批 | 前后端可并行；集成测试依赖实现全部合并 |
| **worker_done** | 角色完成回执 | 必须带 outcome（succeeded/failed）+ 工件路径 + 改动文件 |
| **escalation / question** | 阻塞提问 / 升级 | 回到人；协调器不猜 |
| **check / ack** | 收件箱轮询与确认 | 先处理所有消息再 ack；空等待是 checkpoint 不是失败 |
| **release / retain** | 释放/保留 worker 会话 | 结算后才能释放 |
| **positive proof** | 只有确证退出才 stop/retry | 联系中断 ≠ 进程死亡；不重复派发 |

### 3.1 协调循环

1. `run-create`（objective、proposalId、targets、预算）。
2. 先启动**完整独立波次**，再等待；不边等边补发。
3. `check --wait` 收 `worker_done / escalation / question`；逐条处理后再 ack。
4. 每个 Task 结算后：复用同一 worker（立即 follow-up）/ 保留 / 释放，三选一。
5. 连续空等待后枚举 `worker-list`，按 `attention/nextAction` 处理；只有确证停止才重试/停止。
6. 全部 Dispatch 结算且无待决策终端，才结束 run 并汇总。

### 3.2 自主推进策略

- **触发**：G2 通过后，协调器自动派发实现波次，不再逐步问人。
- **并发**：默认 `maxParallel=3`（沿用 Config），同一 target 的写域冲突任务串行。
- **重试**：每 Task 最多 2 次；第二次失败升级给人（带失败证据与已尝试）。
- **预算**：run 级 token/时间/attempt 上限；超限暂停并上报。
- **停止**：明确「全部成功 / 部分失败并上报 / 阻塞待答」三种终态；不得静默结束。
- **审计**：每次 dispatch / done / gate / decision 写 append-only events，面板可回放。

## 4. 工件与证据

提案目录（`openspec/changes/<id>/`）新增：

| 文件 | 作者 | 内容 |
|---|---|---|
| `REQ.md` | requirement-evaluator | 目标、边界、禁止项、假设、验收判据 |
| `PLAN.md` | solution-evaluator | 方案、模块、目标矩阵、依赖 DAG、风险、回滚 |
| `TASKS.json` | solution-evaluator | `{id, role, project, writes, depends_on, acceptance, status}` |
| `TEST.md` | integration-tester | 场景、命令、结果、失败复现、覆盖缺口 |
| `TEAM-REVIEW.md` | reviewer | severity/file/line/status、独立身份、证据引用 |
| `SUMMARY.md` | coordinator | 每个 Task 的 outcome、证据、未解阻塞 |

与现有门禁的关系：`TEAM-REVIEW.md` / `TEST.md` 直接喂给现有 `review-gate` 与归档审查；`TASKS.json` 的 writes 复用 `swarm/plan.ts` 的 `scopesIntersect`；证据引用沿用 `reviewEvidenceGate` 的机检规则。

## 5. 与现有 WorkMate 能力的关系

| 现有能力 | 团队编排怎么用 |
|---|---|
| `ProposalTarget`（多仓/分支） | Task 的 placement：每个 target = 项目 + 基线分支 + worktree |
| `swarm` 任务级 worktree + writes 装批 | 团队实现波次的物理隔离；团队 Task 可直接映射为 swarm task |
| `worktree` 生命周期 | worker cwd = 对应 target 的 worktree |
| `review-gate` / `approval-gate` | G2 人确认、G4 独立审查、G5 合并/归档批准 |
| `events.jsonl` / metrics | run/task/dispatch/gate 事件；度量沿用现算 |
| 面板 | 新增「团队」视图：角色、DAG、收件箱、当前 Task、证据链接 |

## 6. 工具面（新增）

建议新增（命名可再定）：

- `workmate_team_plan(proposalId, template, roles?)` → 建 Run + 读 `TASKS.json` 校验 DAG。
- `workmate_team_dispatch(runId, taskId, role, sessionPreset?, model?)` → 派发一个 target 的 worker（原生 Session，cwd=worktree）。
- `workmate_team_check(runId, wait, types, timeoutMs)` → 收件箱；返回 `worker_done / escalation / question`。
- `workmate_team_reply(messageId, body)` / `workmate_team_escalate(taskId, question, tried)`。
- `workmate_team_gate(runId, gate, decision)` → G2/G3/G4 的通过/拒绝与理由。
- `workmate_team_status(runId)` / `workmate_team_release(taskId)`。
- 与现有 `workmate_proposal_*` 保持单向：团队不改提案状态机，只推进到现有门前。

## 7. 面板

- **团队看板**：角色列（需求/方案/前端/后端/测试/审查）+ 每个 Task 的状态（planned/dispatched/running/done/failed/blocked）。
- **DAG 视图**：依赖边、波次、关键路径。
- **收件箱**：question/escalation 列表，一键回答；阻塞的 Task 高亮。
- **运行时间线**：dispatch/done/gate 事件，附工件链接与 commit。
- **证据面板**：REQ/PLAN/TEST/REVIEW/SUMMARY 的渲染（复用 MarkdownText）。

## 8. 安全与边界

- 所有业务操作走 Host 服务身份与项目权限；worker 的权限预设由人设定，Bot/角色不得自行提权（借 DS Bot 的权限模型）。
- 团队不得修改 WorkMate 自己的门禁配置；不得绕过 `merging/archiving` 人工批准。
- 外部文本（需求、issue、网页）一律视为不可信输入；需求评估阶段做注入筛查（现有 decision 节点）。
- 记忆/上下文：每个角色 Session 自带宿主压缩；跨 Task 的交接用 `SUMMARY.md`/handoff note，不复制整段对话。

## 9. 分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| T1 | 角色与工件契约：`REQ/PLAN/TASKS/REVIEW/TEST/SUMMARY`、`workmate_team_plan` | 无 |
| T2 | Run/Task/Dispatch + DAG + `check/reply/done` + 自主波次 | 多目标 worktree（另一提案） |
| T3 | 五角色 worker 的 prompt/tool 预设 + 独立审查 | T1/T2 |
| T4 | 团队面板（看板/DAG/收件箱/证据） | T2 |
| T5 | 模板库（需求全流程 / bug 修复 / 调研 / 交付）与度量 | T3 |

## 10. 开放问题

1. 协调器是「一个长期 Session」还是「无状态的 WorkMate 服务 + 按需唤醒的协调 Agent」？
2. 角色 worker 用 Subagent 还是独立 Session？需要跨轮次保留时用哪种？
3. G2 确认门默认强度：所有提案都过人，还是只有高风险/多仓库过人？
4. 前后端角色是否按 target 进一步拆分（每个仓库一个 worker）？并发上限多少？
5. 集成测试是否允许改测试代码/临时脚本？边界写在哪一层？

---

# 四问四答：推荐实现方案（2026-10-19）

> 结论先行：Q1 自研编排层、借 `dsh-expert-team` 的角色/工件；Q2 协调器用顶层 Session、worker 用可续跑 Subagent；Q3 G2 按风险分级、默认一键人确认并绑定方案哈希；Q4 集成测试用写域允许清单 + 升级，不改业务代码。

## Q1：复用 `dsh-expert-team` 作为执行引擎，还是自研编排层？

**推荐：自研编排层，借它的角色表、工件命名与门禁语义；不把它作为依赖/引擎。**

理由：

1. **两套状态机**：`dsh-expert-team` 自带 `STATE.json` / `ROSTER.json` / `TASKS.json` / `session-runs.json`，而 WorkMate 已有八态提案、events、swarm、review/approval 门禁。装成引擎会出现「团队 run 状态」与「提案状态」两份权威，归档门不知道听谁的。
2. **单工作区 vs 多仓 target**：它的模型是「一个工作区 + 角色 subagent + 工件目录」；没有 `ProposalTarget`（项目 × 基线分支 × worktree）概念，无法把前后端 worker 分配到不同仓库的 worktree。
3. **门禁重复**：它的硬门/确认门与 WorkMate 的 review/approval/plan-drift 门禁重叠；两套门禁同时存在会让「到底谁放行」不可审计。
4. **可借的部分已经足够**：12 角色表、9 阶段顺序、`SPEC/PLAN/TASKS/REVIEW/TEST/SUMMARY` 工件命名、硬门/确认门语义，都是 MIT 可直接借鉴的「设计资产」，不需要运行时耦合。

实现方式：

- `src/features/team/vocab.ts`：角色 id、工件名、门禁 id 的唯一真源（对应它的 `lib/vocab.js` 做法）。
- `assets/team/prompts/<role>.md`：角色提示词；借鉴其角色职责划分，保留 MIT 归属说明（NOTICE）。
- `TeamEngine` 接口：`plan / dispatch / check / gate / settle`；默认实现 `native`，未来可加 `expert-team` 适配器（spike，不承诺）。
- 配置：`team.engine: 'native'`（默认）；不引入 `@yangdcm/dsh-expert-team` 依赖。
- 验收：一个提案用 native engine 跑通全流程；`package.json` 无该依赖；角色提示词有版本号。

**如果坚持复用**：先做一个只读 spike——把它的 `/team` 流程用适配器包装成「一个 Task 执行器」，而不是让整个提案生命周期交给它；成本高于自研编排层，不建议作为基线。

## Q2：worker 用独立 Session 还是 Subagent？

**推荐：协调器用独立顶层 Session；角色 worker 用可续跑的 Subagent（in-process spawn）。**

宿主契约（已核实）：

- `ctx.subagents.startActivation({ provider, cwd, request, delivery })`：**支持 `cwd`**；子会话拥有自己的目录并跨继续/重启保留；权限在启动时固定、不能自行放宽；`maxDepth` 默认 1、`maxActiveSubagents` 默认 8；支持 `sendMessage`、`interrupt`、`listChildren`、cold resume、`dispose`。
- `ctx.sessionController`：创建/恢复顶层 Session、Workspace 归属、历史与 Client 投影；适合「人在侧栏能点开看」的会话。
- `ctx.workingDirectory`：Session 级 cwd 投影；Subagent 的 cwd 在启动时确定，后续父会话改目录不影响它。

为什么不全部用独立 Session：

- 7 个角色都建顶层 Session 会污染 Workspace 侧栏、增加归属/权限/归档复杂度；worker 是「一次任务的工作单元」，不是用户要长期浏览的会话。
- Subagent 的 parent-child 归属、容量上限、完成通知、消息/中断/列举，正好是协调器需要的；且子会话可冷恢复，满足「跨轮次保留」的核心诉求。
- 顶层 Session 留给协调器：它是用户观察/介入的入口，需要 durability 与 UI 可见性。

实现方式：

- Run 持有 `coordinatorSessionId`（顶层，cwd=主项目，preset=`workmate-coordinator`）。
- `dispatch`：`startActivation({ provider: 'spawn', cwd: target.worktreePath, request: { prompt, agentOptions: { model/preset } }, delivery: 'caller' })`；记录 `childId` 与 `dispatchId`。
- 后续消息：`sendMessage(childId, ...)`；停止：`interrupt(childId)`；状态：`listChildren(coordinatorSessionId)`；释放：`dispose()`。
- 降级：若 subagents 服务不可用，用 `sessionController` 为 worker 建顶层会话（cwd=worktree），状态与并发退化但仍可跑；这是 T2 的宿主探针项。
- 提升规则：某 worker 需要用户独立打开/跨协调器重启保留时，提升为顶层 Session，并记录 `promotedFrom`。

验收：两个不同 cwd 的 worker 并行、各写各的 worktree；协调器可消息/中断；协调器重启后子会话可 cold resume。

## Q3：G2 确认门强度——所有提案都过人，还是高风险/多仓才过人？

**推荐：按风险分级；默认所有提案 G2 过人一键确认，高风险/多仓强制人；低风险单仓可配置为自动。**

| 条件 | G2 处理 |
|---|---|
| 多 target（≥2 仓库/项目） | **强制人确认** |
| 数据/DB/schema 迁移、公共 API/契约变更、权限/鉴权 | **强制人确认** |
| 风险判定 high | **强制人确认** |
| 单 target、低风险、无迁移 | 默认人一键确认；`team.autoApproveLowRiskG2=true` 时，在 solution-evaluator + reviewer 双签后自动放行 |
| G2 通过后 PLAN/TASKS/REQ 有任何改动 | 方案哈希失效，**重新打开 G2** |

实现方式：

- G2 通过记录绑定 `planHash`（`REQ.md + PLAN.md + TASKS.json` 规范化后 sha256）与 targets 快照；面板展示「批准的是哪一版」。
- 复用现有 approval-gate 记录（actor=human、时间、理由、覆盖 commit/方案哈希）。
- 自动放行必须同时满足：单 target、`risk != high`、无 migration/API/auth 标记、reviewer 与 solution-evaluator 双签。
- 变更方案后：计划漂移/哈希不一致时 G2 重新打开，不允许「旧批准覆盖新方案」。

验收：多仓提案必过人；单仓低风险在开关打开时自动放行；方案改动后重新要人确认。

## Q4：集成测试的边界——允许改测试代码/临时脚本，不允许改业务代码，够吗？

**推荐：写域允许清单 + 升级规则；够，但要把它写进 Task 的 `writes` 并由结算机检。**

允许写：

- 测试与夹具：`**/src/test/**`、`**/test/**`、`**/tests/**`、`**/__tests__/**`、`**/*.test.*`、`**/*.spec.*`、这些目录下的 fixtures。
- 验证脚本：`scripts/verify/**`；运行期临时文件：`<worktree>/.workmates/<proposalId>/tmp/**`。
- 测试依赖变更（`pom.xml` / `package.json` / lockfile）**不算默认允许**：需要单独 Task + 人批准，避免借测试之名改运行时依赖。

不允许写：

- 生产源码、迁移脚本、运行时配置、CI 密钥/凭据。
- 借测试改动生产行为（例如放宽断言、跳过用例、改 mock 让失败变通过）—— `TEST.md` 必须列出新增/修改的测试与覆盖缺口。

跨仓集成测试：

- 在 `PLAN.md` 指定「测试归属 target」（默认主项目；也可单独 `verify/` 目录），测试代码只落在一个 target，避免三仓各写一份。
- 每个 target 的测试命令都在各自 worktree 里执行；跨仓契约测试用 fixtures/契约快照，不连生产。
- 需要真实环境（生产库/外部服务）时：默认禁止；必须人批准、只读凭据、结果写 `TEST.md`，且不得写入生产数据。

机检：

- Task 结算时校验 `git diff --name-only` 是否全部落在允许清单；越界即 `violated`，Task 不得 done。
- `TEST.md` 必须含命令、退出码、关键输出/日志路径；缺失或引用不存在 → G3 失败。

验收：集成测试只能改测试/夹具/验证脚本；越界被结算拦下；生产依赖变更必须单独走审批。

---

# 提案完成即编排：两道人门（2026-10-19 用户反馈）

**问题**：OpenSpec 调研/设计阶段已经把 `proposal.md / design.md / tasks.md / specs` 写完，看板还要求依次点击「提案阶段 → 实现与合并 → 已归档」并逐态审核。这是**重复阅读 + 重复确认**：提案内容已经是方案，团队不需要再读一遍、人也不需要逐格放行。

**原则**：

1. **提案内容即执行依据**：`PLAN.md` / `TASKS.json` 就是团队编排的输入，不再让需求/方案角色重写或重新评审一遍。
2. **状态是证据的投影**：状态由「工件是否完整、方案是否批准、任务是否完成、审查/测试是否通过、分支是否合并」派生，不由人点击推进。
3. **只剩两道人门**：G2 方案确认（一次）、G5 合并/归档（一次）；其余全部自动。
4. **审计不丢**：自动转移写 `events`，带证据快照与 `auto:evidence` 标记；人工门保留 approval 记录。

**可见流水线**：

| 可见阶段 | 内部状态 | 进入条件 | 触发 |
|---|---|---|---|
| 方案 | `draft` → `proposing` | 提案创建，OpenSpec 工件生成 | 自动 |
| 待确认 | `reviewing` | 工件完整 + OpenSpec validate + `planHash` 生成 | 自动 |
| 已确认 | `ready` | 人 G2 确认该 `planHash` | **人（一次）** |
| 执行中 | `implementing` | 团队 run 启动、各 target worktree 创建 | 自动 |
| 待合并 | `merging` | 全部 target 实现完成 + 代码审查 + 集成测试通过 | 自动 |
| 归档中 | `archiving` | 人 G5 批准；各 feature 分支合并进基线 | **人（一次）** + 自动 |
| 已归档 | `archived` | 归档编排成功 | 自动 |

**两道人门**：

- **G2**：G1 产出后先自动机检（solution-evaluator + reviewer；CRITICAL 阻断、其余提示），人只确认 `planHash`（REQ+PLAN+TASKS 规范化 sha256）与 targets 快照；方案任何改动都会让批准失效、自动退回待确认。
- **G5**：一次批准覆盖「合并 + 归档」；批准后协调器合并各 target 分支并跑归档编排。默认把原来的 merging/archiving 两道人工批准合并为一道，可在配置中恢复两道。

**UI**：

- 看板改为**流水线视图**：卡片显示「方案 → 待确认 → 执行中（开发/审查/测试）→ 待合并 → 已归档」的当前位置与进度；
- 默认动作只有两个：「确认方案」「合并并归档」；不再有逐态「推进」按钮；
- `workmate_proposal_archive(mode=advance)` 保留为手动覆盖/回退入口，但正常路径不调用；
- 详情里显示证据：工件完整性、`planHash`、团队 Task 状态、审查/测试结论、target 合并状态。

**实现要点**：

- 新增 `ProposalReadiness` 评估器：读 OpenSpec 工件、`planHash`、审批记录、团队 run/Task、target 分支合并状态，输出「当前可进入的状态」。
- 新增 `reconcile(proposalId)`：幂等计算目标状态并推进，只走非人工门；人工门未批准时停在门前。
- 触发点：提案创建、G2 批准、团队 run/Task 事件、G5 批准、归档完成、面板读取时惰性 reconcile。
- 事件：`transition` 增加 `auto: 'evidence'` 与 evidence 快照；人工门仍写 approval。
- 兼容：旧提案按同一评估器推导；`advance` / `transition` 手动入口保留，但不再作为 UI 主路径。

---

# 最终确认（2026-10-19）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 编排引擎 | **自研编排层**；借 `dsh-expert-team` 的角色/工件/门禁，不引入依赖 |
| Q2 | worker 形态 | **协调器顶层 Session + worker 可续跑 Subagent**（cwd=target worktree） |
| Q3 | 团队入口 | 已有完整 OpenSpec 工件 → 直接 G2；一句话需求 → G0/G1 |
| Q4 | G2 强度 | 风险分级；多 target/迁移/API/权限/high 强制人，低风险默认一键确认 |
| Q5 | 角色权限 | 评估/审查只读；开发/测试/协调器 workspace 写；不默认 full access |
| Q6 | 角色模型 | 先统一会话默认，保留角色级覆盖 |
| Q7 | 测试边界 | 写域允许清单；生产源码/迁移/运行时配置/测试依赖变更单独审批 |
| Q8 | 项目来源 | **本期接入 DSH Workspace 候选发现**（过滤 git/openspec，一键加入注册表） |
| Q9 | G5 拒绝 | 方案问题→ready 重走 G1/G2；实现问题→implementing 生成修复 Task |
| Q10 | 默认限额 | 并发 3；每 Task 2 次重试；2h / 300k tokens / 20 Dispatch |
| Q11 | 实施顺序 | 先工作台（targets/worktree/生命周期/UI/Workspace），再团队 |

> Q8 推翻了 `multiproject-branch-workbench` 原 decision-3 中「workspace 自动扫描留到后续」的范围限定（已用 `supersedes=decision-3` 记录）；OpenSpec 主项目权威与「起会话留后续」不变。
