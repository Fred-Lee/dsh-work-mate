# Helmsman 使用手册

## 1. 日常工作流

1. **创建项目群**：Dashboard 左上 ⚙️ → ➕ 新建 → 填名称（如「订单中台」）。
2. **登记服务**：服务列表 → ➕ 添加服务 → 填服务名与本地 git 仓库路径 →
   🔄 扫描 API（自动发现 Spring/NestJS/Express 端点）→ 💾 保存。
   也可以 📥 导入 docker-compose.yml / K8s manifest / OpenAPI JSON 批量创建。
3. **派发并行任务**：新任务卡输入 Prompt → 勾选 Agent（未安装的会标注 ⚠️）→
   ▶ 并行执行。每个 Agent 在主仓库的独立 `git worktree` 中执行互不干扰。
4. **观察执行**：每个活动任务通过 SSE 事件流实时推送（`/api/task/:id/stream`），
   Agent 卡片状态机与日志由流事件驱动（准备环境 → 执行中(计时+日志) → 完成/
   失败/超时/限流），不再逐条轮询；断线会自动按最后的事件游标重连补拉，不丢不重。
   卡片上方若显示「断线重连中/正在按游标重新同步」即正在补拉；若历史早于游标已被
   清理，会显示 `history-pruned` 横幅。任务全部结束（终态）后流自动关闭。
5. **对比与合并**：完成的卡片点击「查看Diff」进入对比视图：
   - 左右并排 / 统一格式 / 多 Agent 并排三种视图；
   - ⚡ 冲突文件按**真实冲突**标注（补丁无法干净应用，读取自 `GET /api/task/:id/conflicts` 的只读 dry-run），
     并给出逐文件裁决（采用某个 Agent 方案 / 手动编辑保留 / 跳过该文件）；
   - 💬 行级评论（存本地 localStorage）；
   - 底部操作：✅ 合并单个 Agent、🔀 合并所选文件、❌ 全部放弃。
   - merge / discard 是敏感操作，默认需要**代码级确认**：合并/放弃前会弹出确认，
     通过 `POST /api/approvals`（请求）→ `POST /api/approvals/:id/decision`（批准签发一次性令牌）
     拿到令牌后才执行；把对应操作策略改为 `auto-grant` 可回到无确认直跑。
   - 干净变更（含多 Agent 对同一文件的不重叠改动）默认直接合并；**真实冲突会使整次合并中止、
     基础仓库保持原状**，需在下方逐文件裁决后重新「合并所选」。每个合并决定的裁决载荷
     （`resolutions`）会写入 run 时间线（`merge-decision` 事件）与审计日志。

### 服务依赖录入与体检（🕸️ 依赖拓扑）

1. 配置面板 → 🕸️ 依赖拓扑 → ➕ 添加依赖 → 选**调用方**与**被调用方** → 💾 添加，即完成
   「A 调用 B」的声明（**服务级边**：`endpoints: []`、`method: '*'`）。依赖区块只显示一行
   `A ──▶ B`，不需要逐个录入 HTTP 方法与端点路径。
2. 需要精确到接口时展开「端点明细（可选）」，填方法与端点路径；该明细会**并入同一对服务
   的那一行**（内部按 (method, endpoint) 去重），不会另起一行。同一对服务重复添加同样只保持
   一行，**保存是幂等的**——去重在服务端保存路径上执行，所以配置页、导入（compose/K8s/
   OpenAPI）与直接调 API 三条写入路径都满足「同一对服务只有一条边」。
3. 💾 保存后服务端做一次**图体检**，有问题时在配置页顶部以告警条列出（**仅提示，不阻断保存**；
   图干净时整条不显示）：
   - 🔁 **依赖环**：列出环内服务（如 `A → B → A`）。「架构不应存在循环调用」是约定，出现即
     需要调整依赖方向。
   - ⚠️ **悬空引用**：某条边的被调用方不是已登记的服务（通常是服务改名/删除后残留的边）。
   - 💤 **孤立服务**：既无出边也无入边的服务，通常是漏登记了依赖。
4. 只读查询（脚本/调试）：`GET /helmsman-dashboard/api/topology/health?group=<群名>` 返回
   `{ group, available, health: { cyclic, cycles, dangling, isolated } }`；旧版本拓扑服务没有
   该能力时 `available: false`，配置页不显示告警条。
5. 注入文本（`cascade` 模式给 Agent 的拓扑上下文）同样降级：无明细的边写成
   `- A --▶ B`，带明细的边仍为 `- A --GET--> B /api/x`。

## 2. 工作台（Helmsman Workbench）

装入 `@helmsman/ui-workbench` 后，DSH 网页侧边栏底部出现 **🚀 Helmsman** 按钮：

1. 点击打开右侧抽屉，五个面板随时切换：
   - **📚 研究**：输入主题 → ▶ 生成研究笔记（走 DSH 预设会话 + 当前模型，约 30s~2min）。
   - **📋 PRD**：从需求/研究笔记生成 PRD 草稿。
   - **⚡ 执行**：内嵌执行看板；也可「↗ 在新页面打开完整看板」。
   - **🕸️ 知识**：加载项目知识图谱（拓扑 + 已归档文档）。
   - **📦 交付物**：已注册产物（草稿/归档笔记/拓扑导出/任务包）列表与下载链接。
2. **📄 草稿**：生成产物列在面板下方，「查看」读全文，「✅ 归档」把定稿写入
   Tolaria vault（`~/.helmsman/vault/`）——未归档的草稿只留在本地。
3. **自定义指令**：输入框上方的指令 chips（「＋ 指令」新建），一键填入并运行；
   存储于 `~/.helmsman/workbench/commands.json`。
4. **对话 → 任务卡片**：把一段对话「保存为任务」，在**任务工作项**里继续推进
   （模型/四阶段/关联/WIP 详见 `docs/TASK-MODEL.md`）：
   - `GET /helmsman-workbench/api/sessions[?limit=20]` — 最近 DSH 会话门面（`id` + 标题），
     供选择器列候选；没有可用会话缝隙时返回 `{ sessions: [], available: false }`（不是报错）。
   - `POST /helmsman-workbench/api/task-from-conversation`
     `{ title, sessionId?, repo?, projectGroup?, stage?, summary? }` → 建档并返回
     `{ ok, id, stage, summary, associations, item, context, warnings }`：
     读该会话最近消息 → 生成 **2–4 行中文摘要**（`generatedBy: model`）→
     调 `helmsman.board.create(...)` → 把来源会话作为 `conversation` 关联挂到卡片。
     模型不可用或生成失败时摘要退化为最近消息前 ~200 字（`generatedBy: fallback`），
     **不会因此丢卡**；自带 `summary` 时按原文存为 `manual`，不调用模型。
   - `repo` / `projectGroup` 至少给一个（卡片按「仓库 × 模块」算 WIP 冲突域）；只给
     `sessionId` 时会用该会话的 cwd 推断 `baseRepo`，都拿不到则以 `invalid repo` 400 拒绝。
   - 未安装 `@helmsman/board` 时该接口返回明确错误（「未安装 @helmsman/board 插件」），
     工作台其余功能不受影响。
5. **看板页**：`/helmsman-board/`（`@helmsman/ui-board`）按四阶段列展示任务卡片，
   阶段推进、关联与摘要都在卡片详情里操作；从工作台建档后可直接在这里打开卡片。
6. 独立页：`/helmsman-workbench/`（不带斜杠会自动 301 跳转）。

生成工具也可在对话/headless 中直接调用（见 §3）；生成过程中模型再次调用
生成工具会被拒绝（递归闸门），单次生成超 240s 自动取消。

## 3. 状态参考

### Agent 卡片状态

| 状态 | 含义 | 可用操作 |
|---|---|---|
| ⚪ 待命 | worktree 已创建，排队中 | — |
| 🔄 执行中 | agent CLI 正在运行（计时/流式日志） | ✕ 取消 |
| ✅ 完成 | 退出码 0，diff 已收集 | 查看Diff |
| ❌ 失败 | 非零退出（错误摘要见卡片） | 重试 |
| ⏰ 超时 | 超过 timeoutSec（默认 300） | 重试 |
| ⏱️ 限流中 | CLI 报 429/rate limit，自动指数退避重试（最多 3 次） | 稍后重试 |
| 🔐 认证失效 | 401/invalid api key，不自动重试 | 配置密钥后重试 |

### 任务级状态

`CREATING_WORKTREES → RUNNING → AGGREGATING → COMPLETED | PARTIAL_FAILED | ALL_FAILED`
（RUNNING 中可取消 → CANCELLED）。部分失败时成功的 Agent 结果照常可用。

## 4. Agent 工具（headless 驱动）

Helmsman 同时注册了一组 agent 工具，可以在 `dsh --profile <p> "…"` 会话里直接指挥舰队：

- `helmsman_run_parallel {prompt, agents, projectGroupId?, repoPath?, cascade?, timeoutSec?}`
- `helmsman_task_status {taskId, withLog?}`
- `helmsman_cancel_task {taskId, confirmationToken?}` — 默认策略 `cancel` 为 auto-grant（无令牌直跑，仍记审计）
- `helmsman_merge_task {taskId, mode?: merge|discard, agents?, files?, discardAfterMerge?, confirmationToken?, resolutions?}`
  — `mode: merge` 默认需要确认令牌（策略默认 confirm-required）；`confirmationToken` 由
  `helmsman_request_confirmation` + `helmsman_decide_confirmation` 签发；`resolutions` 为可选 JSON 字符串，
  表示每个真实冲突文件的逐文件裁决（`{"<file>":{"kind":"agent","agent":"claude"}}` / `{"kind":"manual"}` / `{"kind":"skip"}`）。
  headless 合并只允许全干净：任一真实冲突即整体中止并返回冲突文件清单，不做静默单侧合并。
- `helmsman_request_confirmation {op, taskId?, group?}` — 门控第一阶段：为 merge/discard/cancel/
  worktree-cleanup/topology-delete 记录挂起审批请求，返回 `approvalId`
- `helmsman_decide_confirmation {approvalId, approve}` — 门控第二阶段：批准签发一次性作用域令牌（默认 300s 有效），拒绝则关闭该请求
- `helmsman_topology_get_downstream {projectGroupId, serviceId}`
- `helmsman_topology_scan_rest_apis {localPath}`
- `helmsman_topology_list_groups`
- `helmsman_research {prompt}` — 起预设会话做 Deep Research，落研究草稿
- `helmsman_generate_prd {prompt, noteId?}` — 生成 PRD 草稿
- `helmsman_decompose {prdId}` — PRD 拆解为里程碑/任务
- `helmsman_require_analyze {requirement, projectGroupId?}` — 知识库复用/新建评估

示例：`dsh --profile headless "使用 Helmsman 执行任务：用 claude 和 codex 并行给 user-service 加一个修改密码接口，然后合并 claude 的结果"`。

Headless 合并需要两步（默认策略）：
1. 先用 `helmsman_request_confirmation {op:"merge", taskId}` 拿到 `approvalId`；
2. 再让操作者确认（如在仪表盘治理面板批准，或本机调用 `helmsman_decide_confirmation {approvalId, approve:true}`）拿到一次性令牌；
3. 最后 `helmsman_merge_task {taskId, confirmationToken:"<token>"}` 执行。
若合并遇真实冲突，会整体中止并返回冲突清单与「请在 diff 界面逐文件裁决后重试」指引（裁决以 `resolutions` 随合并提交）。

## 5. 配置

所有插件都接受 profile patch 层的 config 覆盖（`~/.dsh/profiles/<p>/cordis.patch.yml`，
同 id 行 = 覆盖配置，改完自动热重载）：

```yaml
# 覆盖 claude 适配器的命令与参数
- id: helmsman-adapter-claude
  config:
    command: claude
    args: ["-p", "{prompt}", "--output-format", "text"]
    env: {}

# orchestrator 策略
- id: helmsman-orchestrator
  config:
    defaultTimeoutSec: 300
    maxRateLimitAttempts: 3
    circuitBreakerThreshold: 5
    circuitBreakerCooldownMs: 30000
    # 执行历史保留策略（host 重启后任务列表/详情/事件时间线仍可审计）
    historyDir: ~/.helmsman/history   # 可选：历史目录（默认取 HELMSMAN_HOME/history）
    retention:
      maxTasks: 50                    # 保留最近 N 个任务记录（默认 50）
      maxEventRowsPerTask: 2000       # 每任务事件行数上限，更早的会被清理（默认 2000）
    # 可选：覆盖确认策略文件/审计日志路径（默认取 HELMSMAN_HOME 下 policy.json / audit/audit.jsonl）
    policyPath: ~/.helmsman/policy.json
    auditPath: ~/.helmsman/audit/audit.jsonl

# worktree 存储位置
- id: helmsman-worktree
  config:
    rootDir: ~/.helmsman/worktrees

# dashboard 挂载路径
- id: helmsman-ui-dashboard
  config:
    mountPath: /helmsman-dashboard
```

### 敏感操作确认策略 `~/.helmsman/policy.json`

merge / discard / cancel / worktree 清理 / topology 删除是敏感（破坏性）操作，由
服务核心的**两阶段门控**把关（request → decide → execute(一次性作用域令牌)，默认 TTL 300s）。
策略文件按操作分类为 `confirm-required`（需确认，默认）或 `auto-grant`（自动放行，仍记审计）：

```json
{
  "operations": {
    "merge": "confirm-required",
    "discard": "confirm-required",
    "cancel": "auto-grant",
    "worktree-cleanup": "confirm-required",
    "topology-delete": "confirm-required"
  },
  "tokenTtlSec": 300
}
```

- 文件缺失 → 使用以上默认值（保持「破坏性变更前需确认」的既有行为）。
- 想恢复 headless 便利：把 `merge` / `discard` 改为 `auto-grant`（仍会写入审计）。
- 未知操作键 / 非法模式值 / 非法 `tokenTtlSec` 会被拒绝并回退到默认策略（fail-closed）。

### 审计日志

每个被门控的决定（granted / denied / auto-grant）在副作用发生**之前** fsync 落盘，
写不进去即中止该操作；合并执行（含裁决载荷与真实冲突清单）、放弃与每次运行到达终态
都会追加 `run-completion` 条目。文件为追加式 JSONL（只读查询面，无任何变更端点）：
`~/.helmsman/audit/audit.jsonl`（可用 `HELMSMAN_HOME` 覆盖）。
仪表盘右下角 🛡️ **治理** 面板可查看待确认列表（批准/拒绝）与审计日志。

数据目录：`~/.helmsman/topologies/`（项目群 JSON）、`~/.helmsman/worktrees/`
（任务 worktree，任务合并/放弃后自动清理）、`~/.helmsman/history/`
（任务生命周期摘要 `tasks.json` + 每任务事件时间线 `tasks/<taskId>.jsonl`，
宿主重启后任务列表与详情仍可见，被打断的任务以其最后已知状态展示）、
`~/.helmsman/audit/`（审计 JSONL）、`~/.helmsman/board/`
（**任务工作项**：`items.json` 卡片快照，tmp+rename 原子写；`events.jsonl` 阶段迁移/关联事件。
`items.json` 损坏时启动报错并保留原文件，不静默重建——模型与四阶段见 `docs/TASK-MODEL.md`）。

REST/SSE 补充端点（供脚本/调试）：
- `POST /helmsman-workbench/api/task-from-conversation` — 对话 → 任务卡片（见 §2.4）。
- `GET /helmsman-workbench/api/sessions` — 最近 DSH 会话门面（`id` + 标题）。
- `GET /api/task/:id/events?after=<seq>` — 有序事件 + `nextCursor`；cursor 已是最新时为空；命中已清理区间返回 `pruned: true`。
- `GET /api/task/:id/stream?after=<seq>` — SSE：先重放持久化历史再实时 tail，15s 心跳，任务进终态即关闭。
- `GET /api/task/:id/conflicts` — 只读 dry-run：返回该任务当前真实冲突文件清单（`git apply --check`）。
- `GET /api/approvals/policy?op=<op>` — 该操作当前模式（confirm-required / auto-grant）。
- `GET /api/approvals/pending` — 挂起的确认请求列表。
- `POST /api/approvals` — 请求确认（`{op, taskId?, group?}`）→ `approvalId`。
- `POST /api/approvals/:id/decision` — 决定（`{approve}`）；批准签发一次性令牌。
- `GET /api/audit?op=&taskId=&from=&to=` — 只读审计查询（无变更面）。
- `GET /api/topology/health?group=<群名>` — 只读图体检（依赖环 + 成员 / 悬空引用 / 孤立服务），无变更面。
- merge/discard/cancel 与 `POST /api/topology/delete` 均需携带 `confirmationToken`（confirm-required 时）。

## 6. 验证安装

```bash
dsh --profile web --dump-config | grep helmsman      # 15 个 helmsman-* 条目
curl -s localhost:3080/helmsman-dashboard/api/state  # {"groups":[...],"agents":{...}}
open http://127.0.0.1:3080/helmsman-dashboard/
```

深链参数：`?panel=config` 直接打开配置面板；`?theme=dark` 强制暗色。

## 7. 常见问题

- **提示「no repoPath」**：项目群下没有任何服务配置 localPath；在配置面板给
  服务填本地 git 仓库路径，或调用工具时直接传 `repoPath`。
- **「⚠️ 未安装」**：对应 agent CLI 未在 PATH 中（`claude` / `codex` / `pi` /
  `oh-my-pi`）；安装后刷新页面。
- **限流**：被限流 Agent 自动退避重试；也可在配置面板调整策略，或先只勾选
  未限流的 Agent。
- **合并冲突**：冲突以**实际补丁应用失败**为准（`git apply --check`），不再按「某文件被多个
  Agent 修改」推断。真实冲突时整次合并中止、主仓库保持原状；在 Diff 视图按真实冲突文件
  逐文件裁决（采用某个 Agent 方案 / 手动编辑保留 / 跳过该文件）后重新「合并所选」，
  裁决载荷会写入 run 时间线与审计日志。
- **「gate-denied: ... requires confirmation」**：该敏感操作处于 `confirm-required`
  而未携带令牌。用 `helmsman_request_confirmation` + `helmsman_decide_confirmation`（或仪表盘
  治理面板）获取一次性令牌后带上执行；或按需在 `policy.json` 里将该操作改为 `auto-grant`。
- **「audit-unavailable」**：审计日志目录不可写，按 fail-closed 中止了操作；检查
  `~/.helmsman/audit/` 权限后重试。
