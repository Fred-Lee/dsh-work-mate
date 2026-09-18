## 背景(Context)

Helmsman 目前"任务"即 orchestrator 的一次 fleet run(`taskId` 为 run id),生命周期经 change A 落盘(`~/.helmsman/history/`,JSONL 事件时间线)。周边资产散落在:workbench drafts(`~/.helmsman/workbench/drafts`)、Tolaria vault(`~/.helmsman/vault`)、worktree 注册表(`~/.helmsman/worktrees/worktrees.json`)、memory-topology(projectGroup → repoPath、服务节点/REST 依赖)、change D 的 artifact 注册表(`helmsman.artifacts`)、change C 的审计/门控(进行中)。本变更新增 `@helmsman/board` 纯 Service 插件,作为 WorkItem 聚合根,把这些对象以引用关系收拢,并内建四阶段与 DoR/DoD 门数据。UI(看板)由 change `add-task-kanban-board` 另行消费,不在此实现。

## 目标 / 非目标(Goals / Non-Goals)

**目标:**
- WorkItem 成为跨阶段聚合根;run 语义不变,以引用挂接。
- 四阶段迁移与 DoR/DoD 门由 Service 层强制,任何客户端(含未来看板)都不能绕过。
- 关联全部为引用,可离线存、可校验存在性;不复制文档/对话内容。
- 对话摘要(用户可编辑)作为卡片快速浏览入口;board Service 对摘要生成保持模型无关。
- 持久化于 `HELMSMAN_HOME/board`(原子写 + 事件追加),重启可还原。

**非目标:**
- 看板 UI(另立 change);多用户/账号/权限;run 状态机改动;复制或迁移既有工作台/Tolaria 内容。

## 决策(Decisions)

### D1. WorkItem 与 Run 两级解耦
`WorkItem { id, title, summary, repoScope:{baseRepo|projectGroup}, stage, createdAt, updatedAt }` + `runs[]: RunRef{ taskId, startedAt, terminal? }`。board Service 不拥有 run 数据,需要 run 状态时经注入的 `RunStatusReader`(由宿主接 orchestrator)读取。
- **理由**:复用 change A 已落盘的 run 时间线,避免 run 状态双写;向后兼容(`taskId` 语义不变)。
- **替代**:把 run 并入 WorkItem(会重定义 orchestrator 语义并破坏既有 REST/工具)。否决。

### D2. 四阶段为有序枚举 + 单步推进
阶段 `requirements → spec → dev → done`(展示名 `需求分析/规格设计/开发实施/验收归档`)。推进接口每次只允许 +1(可配置 `allowSkip` 默认 false);迁移事件 append 到 `~/.helmsman/board/events.jsonl`。
- **理由**:对应 PRD 管线,杜绝跳级造成的"无 spec 就开发";事件流可被 change C 审计、change A 同款 JSONL 惯例复用。
- **替代**:自由状态机(Jira 式)——灵活但门难以强校验。否决。

### D3. 关联 = 规范化引用 + 展示快照
每类关联存 `{ type, refId, label?, at }`:`refId` 用对象自有 id/路径(如 vault note 相对路径、artifact sha256、run taskId、conversation sessionId)。同时存 `label` 快照(标题/文件名)用于渲染,避免列表页逐个解析;点击跳转时才经宿主服务解析真实对象。关联增删 append 事件。
- **理由**:引用而非副本(避免漂移),label 快照使看板首屏无需 N 次 IO。
- **替代**:存全量副本(漂移)或不存 label(每次渲染解析,慢)。折中如上。

### D4. 摘要模型无关,生成在宿主
`summary: { text, generatedBy: 'model'|'manual'|'fallback', source: 'dsh'|..., at }`。board 只存不生成;生成由 ui-workbench 侧注入(复用其 generator/`ctx.agents` 通道)或退化为最近消息前 ~200 字。claude/codex transcript 仅存路径引用 + 有则用其尾部文本做 fallback。
- **理由**:board 保持纯数据层、可单测;摘要需要 LLM,放在已有 agent 通道的宿主更自然。
- **替代**:board 内嵌模型调用——引入不确定性与失败面。否决。

### D5. DoR/DoD 门 = 数据层校验 + 可选外部裁决
门由两部分构成:(a) 卡片自带门数据(如 `specFinalized: bool`,推进到 dev 前必须为 true);(b) 可选 `GateProbe` 注入(如进入 done 前向 orchestrator/audit 查询"是否存在已 merge run 且审计在案")。校验结果返回缺口清单 `[{key, label, action?}]`。board 不硬依赖 orchestrator/audit,缺省 probe 返回"未知"并提示配置。
- **理由**:Service 不引入对 run 状态机的运行依赖;单测可用桩 probe。
- **替代**:board 直接查 orchestrator 内存/历史——耦合且难测。否决。

### D6. 存储与恢复
`~/.helmsman/board/items.json`(原子 tmp+rename,含 schemaVersion)+ `events.jsonl`(迁移/关联事件)。启动时:读 items.json;若损坏则报显式错误并保留原文件(不静默重建),待用户处理;events 用于审计/重放,不做自动回放恢复(卡片状态以 items.json 为准)。
- **理由**:单文件原子写简单可靠;events 供审计消费(change C),不回放避免幂等复杂度。
- **替代**:每卡片单文件(管理散乱)或 SQLite(依赖)。否决。

### D7. WIP = 冲突域(仓库 × 模块作用域),而非仓库
进入 `开发实施` 时卡片可声明 `scope.module`(spec/关联文档/topology 自动建议 + 用户可改);未声明回退整仓域。WIP 策略键 = 冲突域(键 `repo:module` 或 `repo:*`),同仓库不同 module 互不计数(对应真实场景:"一个仓库可以并行跑不同需求/模块"),同冲突域共享上限(默认 `module:1`,`repo:*` 回退 2;可配置)。评估在 board 服务层做(与 D5 门校验同一次推进检查),结果(拒绝 + 冲突域排队原因)返回给任意客户端。
- **理由**:用户明确指出同一仓库会有并行不同需求——按 repo 一刀切会错误阻塞无关模块;真正的风险是**同一变更面在 merge 阶段冲突**(change A 已把冲突标注做兜底),模块级冲突域是"能表达这种并行、又不放过同域竞争"的最小粒度。
- **替代**:纯 repo 上限(过粗,阻塞无关并行);动态按"运行中 diff 实际重叠文件"预测(精确但需 run 期间持续扫描,复杂度高)。选声明式 module 域:进 dev 时一次声明即可,未声明给回退与提示。

### D8. 借鉴输入：会话/工作区绑定与归档形状(证据等级 B，落地时验证)
相关做法来自相邻项目 DSH-Work-Buddy(MIT, v0.1.998)的生产代码，已集中记录在
`docs/DSH-INTEGRATION-NOTES.md` 的 B 级条目。本变更采纳其中三项作为设计输入，并约定
**落地时逐条验证后升级为 A 级**：
- **会话/工作区绑定序列**：`prepare-session`(写 per-task `AGENTS.md`/`MEMORY.md`、套人格)→
  幂等 `workspace.create({path: 任务目录})`(把任务目录登记为 agent 的 cwd)→
  `session.create({workspaceId})` → 绑定并把 `{sessionId, v:1}` 快照落盘。这正好落进本变更的
  `conversations[]`：对话引用不只是 id，还带工作区绑定，使"任务 = 一个隔离的 agent 工作目录
  + 一段对话"成为稳定形态。
- **per-task 目录即 cwd + per-task 记忆**：任务目录承载 `AGENTS.md`/`MEMORY.md`，人格
  (对应本变更的关联集)与长期记忆分离存放——比"只存对话 id"更能解释"这个任务当时被怎么指挥的"。
- **归档 manifest 形状**：`{taskId, title, startedAt, endedAt, agentIntro, messages, tokens,
  sizeBytes, fileCount, archivedAt, sessionId, files[], conversation[{role,text,time}]}`，
  作为本变更 `artifacts[]` + 归档联动的字段参考。
- **理由**：这三项把"关联"从"存个引用"提升为"可复现当时的工作环境"，且都是别人已在同类宿主
  上跑通的形状；标 B 级是因为尚未在本机 Helmsman 上验证，等 `board` 落地时一并证明。
- **边界**：只借鉴形状与序列，不引入其代码；其内置 harness(rc.7)与本项目目标版本不同，不可用于验证。

## 风险 / 取舍(Risks / Trade-offs)

- [关联对象被删除导致引用悬空] → resolve 时返回"目标不存在",看板显示悬空徽标;卡片仍可编辑/删除关联。
- [WIP/门校验被客户端绕过] → 门强制在 Service 层(D5),客户端只是呈现;看板必须经推进接口。
- [多客户端并发写 items.json] → 单写者假设(loopback 单用户)+ 写前内存态更新序列化;必要时文件锁留待后续。
- [摘要含敏感对话内容] → 摘要存本地单用户目录;文档提示属于同信任边界。

## 迁移计划(Migration Plan)

纯新增,无存量迁移。落地顺序:board 包 + 模型/门 + 事件 → 宿主接线(workbench 建档、artifacts/orchestrator probe)→ 供 kanban 消费。回滚 = 移除插件与 `board/` 目录(无侵入其他包)。

## 开放问题(Open Questions)

- `dev → done` 的"审计在案"如何判定最简:依赖 change C 的 audit JSONL 查询接口,还是仅要求 run 终态已 merge?(apply 时按 C 的最终形态接线;两态都可接受,spec 已写成"存在对应 merge 审计记录"。)
