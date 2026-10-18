# Claude Code 一周工作分析：真实场景、痛点，以及 WorkMate 偏离在哪

- **分析窗口**：2026-10-12 ~ 2026-10-17（6 个工作日）
- **数据源**：`~/.claude/projects/` 下 15 个顶层会话（118 MB）、30 个子代理转录、3,468 次工具调用
- **过滤口径**：只统计 `isSidechain=false` 的顶层会话；真人指令 = `origin.kind=human`，剔除 task-notification / agent-message；token 按 10-11 之后的时间戳求和
- **日期**：2026-10-18

---

## 0. 结论先行

1. 你这一周的真实工作不是「从提案出发的并行新功能开发」，而是**跨 2–3 个仓库的存量系统变更**：先查调用链，再写/改 OpenSpec 提案与技术方案，然后人工组织多轮审查，分仓实现，靠真机/数据验证，最后手工归档。**68% 的文件写操作发生在提案与设计文档上，代码只占 26%。**
2. WorkMate 偏离的不是「以变更提案为中心」——这个定位是对的；偏离的是它的四个隐含假设：**平台（DSH）／粒度（单仓库）／干预点（归档与合并门禁）／使用者（WorkMate 自己）**。
3. 最硬的证据：WorkMate 自己的提案库里只有 **7 个提案，全部是 dsh-Helmsman 自身**；Claude Code 一周 **0 次 workmate 工具调用**；WorkMate 目前**没有 MCP/CLI 入口**，Claude Code 结构上无法调用它。

---

## 1. 一周数据面

| 指标 | 数值 | 说明 |
|---|---|---|
| 顶层会话 | 15（11 个有真人指令） | 最长会话横跨 5 天 |
| 真人指令 | **255** 条 | 另有 18 条 task/agent 通知 |
| 工具调用 | 3,468 次 | Bash 2,253 / Edit 608 / Read 201 / Write 151 |
| 子代理 | 30 个 | Explore 5、architect 3、code-reviewer 1、tdd-guide 1、planner 1、Plan 1、general-purpose 18 |
| OpenSpec 命令 | **377** 次 | validate 49 / status 53 / **archive 0** |
| Edit/Write | 759 次 | **提案与文档 516（68%）**、代码 194（26%）、其他 49 |
| 被编辑文件 | 177 个 | 单个技术方案文档被编辑 **59 次**；design.md 35 次；tasks.md 22 次 |
| 命令级引用仓库 | 11 个 | matrix 902、sync 277、homework 169、sbs 140、ugc 132…（另有 2 个少量引用） |
| 跨仓变更 | ≥4 个 | 其中 2 个在 3 个仓库各存一份同名 openspec 目录（已核实） |
| token | **13.7 亿** | cache read 11.8 亿、input 1.86 亿、output 322 万 |
| 工具报错 | 131 次 | Bash 非零退出 72、Edit 锚点找不到 26、文件不存在 7 |
| 真人打断/纠正 | 36 条（14%） | 含「先不要改代码」×3、5 次工具调用被用户拒绝 |
| 审查/评估指令 | 29 条（11%） | 另有 30 个子代理调用中的审查类 |
| 执行中追加 | 35 条排队（17 真人 + 18 通知） | 同一句「另外找架构师Agent审核…」连发 **5 次** |
| 会话累计计费 | ≈ $889 | 15 个会话的 cost-state 快照（含窗口前已打开的长会话，仅作量级参考） |

按项目分布（真人指令 255 条）：

| 项目 | 指令数 | 典型工作 |
|---|---|---|
| sync-service-consumer | 97 | 按量计费父/子订单、订单同步、xxl-job、OSS 报表、存量订正 |
| zujuan-matrix（Zujuan.UI + 6 站点） | 70 | 作业列表学科切换、埋点、Razor RCL/CDN 迁移 |
| internal-sbs | 48 | 校本自主上传试卷风控/限额、paper_convert、试题 ES 来源 |
| internal-homework | 29 | 错题订正、题组逐小题判定、分支合并 |
| Downloads-data / 本机 | 11 | Redis TTL 审计、Codex/npm 环境修复 |

---

## 2. 一周工作流复原

1. **调研**：用 Explore 子代理 + GitNexus 回答「接口在哪个 Controller」「谁在调用」「数据从哪张表来」。跨 5–6 个仓库是常态。
2. **写提案**：`openspec/changes/<name>/{proposal,design,tasks,specs}` + `docs/` 技术设计方案。**同一个变更在 2–3 个仓库各存一份同名 openspec 目录**（已核实：`fix-wrong-ques-sub-answer-type-expose`、`add-ques-group-sub-correction` 在 internal-homework / homework-server / zujuan-online-job 各一份；`add-parent-order-num`、`school-based-upload-quota-limit` 则是代码跨仓、提案目录只在一处）。
3. **审查**：手动拉起架构师 / 代码审查 / 一致性审计子代理，多轮；用户把长审计报告人工汇总成「修正」「再审核」。
4. **实现**：并行子代理按仓库实现（一次 2 个，最多 3–4 个），人工管分支、提交、推送。
5. **验证**：`dotnet build` / `mvn test` / `yarn lint` + 浏览器/Figma 像素 + 生产库 SQL + 日志关键词，大量环节靠人喂数据。
6. **归档**：手工 `mv` 目录 + 手工同步 delta spec（`openspec archive` 一周 0 次）。

---

## 3. 痛点清单（按证据强度排序）

### P1. 提案期是主战场，但「范围」没有稳定载体

- 68% 的写操作在提案/文档；一个技术方案被改 59 次，`tasks.md` 改 22 次。
- 典型的范围漂移链：用户说「我想只处理 endTime，不要扩大处理范围」→ 代理把排序改造一起删了 → 用户追问「**internal-ugc的改动怎么也没了？**」→ 恢复。30 分钟内 proposal/design/tasks 被整份重写 4 次。
- 「**先不要改代码**」连发 3 次：代理在 4 分钟内改了 6 个文件（配置 + 3 个 Razor 页），用户喊停后代理再回滚。
- 代理过度设计：「再审核下…我感觉**还需要用 redis 好像是设计过剩了**，我只是想切换不同学段的学科」；另一处是 RCL/CDN 集中化。
- 用户口头禅是「**短平快的来解决**」「先不按 source 过滤，后续和客户端一起评估」。

**代价**：范围在对话里来回变，文档是唯一承载，但文档本身又在高频重写——没有「当前生效范围」的单一快照可对照。

### P2. 审查是人工编排的重活，结论不沉淀

- 29 条审查/评估指令（11%）；同一提案反复审：`link-job-list-subject-switch` 在 03:23 / 03:28 / 03:33 连审三次；`add-parent-order-num`「再次审核」；`school-based-upload-quota-limit` 连发 5 条相同指令。
- 审查用掉 30 个子代理里的近 1/3：架构师、Explore、code-reviewer、tdd-guide、planner、以及每轮实现后的「fresh final reviewer」。
- 审查产出是 800–3000 字的长报告，用户只能人工归纳成「可以，修改订变更文档」「修复以上缺陷」。
- 多仓库时还要做「三仓库契约一致性终审」——这类跨仓一致性检查目前完全靠 prompt 里手写 ROLE/SCOPE。

**代价**：审查是串行的、重复的、不可复用的；上一轮审出的问题不会成为下一轮的门禁。

### P3. 跨仓变更没有单一事实源

- 一个变更 = 2–3 个仓库各一份 openspec 目录，靠人肉保持一致；`tasks.md` 里甚至要手写备注「> 本变更跨两个仓库，同名变更分布于…」。
- 原话：「**task中，未明确对应的项目名，我看不出这个**」「homework-server的变更有吗」「internal-ugc的改动怎么也没了？」「需要确认在哪些服务产生变更」「**三个服务的发布顺序是什么**」。
- 发布顺序、数据订正、xxl-job 控制台配置、DBA 工单，都写在文档里而不是结构里：一周出现「阶段 0 / 发布① / 发布②」这类手工编排。
- 同一个变更涉及的服务跨度：internal-homework → homework-server（BFF）→ zujuan-online-job（前端），再加 ES / sync / 基础数据服务。

### P4. 分支与工作区状态脆弱

- 「**学生端，切换到 test 分支后有问题，实现被覆盖了**」——代理诊断为「半合并状态」：别的 feature 分支合入 test 时把模板回退了，script 还留着。
- `git checkout -b fix/20261012` 直接失败：`fatal: 'refs/heads/fix' exists; cannot create 'refs/heads/fix/20261012'`。
- 「feat/自传试卷风控 这个分支为什么关联到远程的 main 分支」「git ai 能否不提交」「internal-homework 能否不回退呢」。
- 一周 38 次 commit、14 次 checkout、7 次 merge、3 次 stash，全部在同一个工作目录里进行，跨仓并行时靠「勿切分支」写进子代理 prompt。

**代价**：长生命周期分支 + 多仓并行 + 代理自动切分支，任何一次状态丢失都要靠对话重建。

### P5. 验证在仓库之外，代理无法自证

- 18 条浏览器/视觉类指令；27 次 Figma 调用；装 `chrome-devtools-mcp`、反复登录、抓 DOM/样式/截图，多次失败（exit 144、EPERM、profile 占用）。
- 像素级返工：「左对齐依然没有实现」「UI 为什么没有变更」「控制台有没有打印日志，我想确认有上报」。
- 数据库：28 次 dbx 调用，keyring 不可用；用户手工贴 SQL 结果和表结构；「update 语句我无权限执行」「我担心 SQL 执行会因为缺少索引超时」。
- 日志：「本次必要的观测日志都准备好了吗？**我要根据什么关键词查**」「我希望可以根据一个订单号，**串联查出所有关于这个订单的处理日志**」。
- 构建/测试：报告「失败的内容是什么，有什么影响」——预存测试失败需要人工分诊。

**代价**：每一轮真机/数据验证都要人参与，验证是当前最大的吞吐瓶颈。

### P6. 索引与提案会过期，代理拿旧事实做设计

- 审计里明确写：「GitNexus 索引落后 336 commits」；「zujuan-online-job 也用 gitnexus 建立索引」；`impact` 报「Repository sync-service-consumer not found」。
- 提案过期：「上次 consolidate-deploy-chunk-to-ui 的改动比较久了，**评估下当前这份变更提案是否还正确**」；审出 exam 试点已失效、tasks 2.2/2.5 分组错误、对比报告已过时。
- `tasks.md` 与代码脱节：「task 我看没变更啊」。

### P7. 长任务没有进度反馈，导致重复发送

- 同一句「另外找架构师 Agent 审核…」在 11:17–11:19 连发 5 次；一周 35 条排队消息（17 条是代理执行期间追加的真人指令）；「还没调研清楚吗？」；「两个子 agent 当前的进度多少」。
- 任务完成靠 task-notification 回灌，一周 18 条，混在对话里成为噪声。

### P8. 上下文与成本

- 6 天 13.7 亿 token（11.8 亿 cache read），output 只有 322 万；会话横跨数天，同一变更反复回到同一上下文。
- 这是「长会话 + 大文档 + 多代理」共同造成的：文档被反复读改写，上下文重复计费。

---

## 4. WorkMate 偏离诊断

### 4.1 四个错位

| 假设 | WorkMate 的设计 | 一周的事实 | 后果 |
|---|---|---|---|
| **平台** | DSH 插件 Bundle，工具/面板/REST 都在 DSH 里 | 工作在 Claude Code；377 次 openspec、30 个子代理、MCP（gitnexus/dbx/figma）全在 CC | 结构上够不着；一周 0 次 workmate 调用 |
| **粒度** | `projectRoot` 单仓库；提案关联一个项目 | 4 个高频业务仓库 + 2 个本机/数据目录；命令级引用 11 个仓库；≥4 个跨仓变更 | 跨仓一致性、发布顺序、契约对齐没人管 |
| **干预点** | 力气在归档/合并门禁、八态生命周期、审批 | 痛点在「范围对齐 → 审查 → 验证」；归档是最后一步，且被手工 `mv` 绕过 | 门禁打不中真正的返工点；`openspec archive` 0 次调用 |
| **使用者** | 面向「ZCode 开发团队」的协作流程 | 你是一人开发，审查者/审批者也是你自己；无团队审批场景 | 审批/独立性/角色门禁没有真实用户 |

### 4.2 自证循环

WorkMate 自己的提案库（`~/.dsh/workmate/proposals.json`）：

```
7 个提案，全部属于 dsh-Helmsman：
add-systemone-decision-provider / fix-panel-scroll / harden-archive-gates /
harden-test-integrity / wire-swarm-independent-review / honest-plan-drift /
harden-openspec-archive-step
最后事件：2026-10-12
projects.json 只注册了 dsh-Helmsman 一个项目
```

也就是说：**WorkMate 当前的「真实用户」是它自己的开发流程**。它的门禁、度量、判断层都是被「开发 WorkMate」这件事塑造的，而不是被你的一周工作塑造的。这是 dogfooding 漂移的典型形态——产品越完整，越像在为一个不存在的团队流程服务。

### 4.3 能力对照：保留 / 降级 / 缺失

| WorkMate 能力 | 一周证据 | 判断 |
|---|---|---|
| 归档编排 + 产物核验 | `openspec archive` 0 次；11 个变更靠脚本 `mv` 归档；delta spec 靠子代理手工同步 19 对 | **真需求**，但要能被 CC 调用 |
| 计划漂移 / 工件账本 | 「提案是否还正确」「task 没变更」反复出现 | **真需求**，但对象应是 openspec change，不是 WorkMate proposal |
| 审查门 + 审查者独立性 | 29 条审查指令、每轮 fresh reviewer、三仓终审 | **真需求**，但发生在设计期，不是归档期 |
| swarm worktree 隔离 | test 分支覆盖实现、建分支失败、跨仓并行写「勿切分支」 | **真需求**，但要在 CC 里做，且要跨仓 |
| 提案面板 / 八态生命周期 | `openspec/` 被 9 个仓库 gitignore，提案本来就不进 git；用户问「为什么我没看到这个提案」 | **弱需求**，且与 OpenSpec 重复 |
| 过程度量 / 控制带 / 判断层 | 一周无任何相关诉求；WorkMate 自己 7 个提案是唯一数据源 | **无使用证据**，建议冻结 |
| wiki / vault / 语义检索 | GitNexus 已在用（40 次），但索引过期、部分仓库未索引 | **方向对但没接上**；单仓生成 10 分钟，赶不上跨仓调研 |
| 审批记录 / 写码者不得批准 | 单人工作，批准=自己 | **场景不存在** |
| 跨仓变更账本 | 一个变更 2–3 个仓库、发布顺序、契约一致性全在文档里 | **完全缺失** |
| 验证 harness（浏览器/DB/日志） | 18 条视觉指令、28 次 DB、日志关键词 | **完全缺失**，且是最大瓶颈 |
| 长任务进度 / ACK | 5 次重复发送、35 条 queued、问「进度多少」 | **完全缺失** |

---

## 5. 建议

### 5.1 三个可选方向

**方向 A（推荐）：把 WorkMate 收缩成「变更上下文层」，做成 Claude Code 可调用的 MCP/CLI。**
保留四件真正被需要的东西，全部围绕「跨仓变更」：
1. **跨仓变更账本**：一个 change → N 个仓库的 openspec 目录、契约字段、发布顺序、数据订正、ops 动作，单一视图；
2. **审查账本**：审查结论结构化（严重度/文件/行/是否已修），下一轮自动带去重与门禁；
3. **漂移检查**：提案 vs 代码/索引的新鲜度（GitNexus 落后 N commits、tasks 未动、文件已改）；
4. **归档核验**：复用现有 `openspec archive` 产物判定逻辑（这套逻辑你已经写过，是全项目最扎实的一块）。

DSH 面板可以保留为可选前端，但不再是唯一入口。

**方向 B：接受 DSH 产品定位。**
如果 WorkMate 的目标用户本来就是「用 DSH 的团队」，那它没有偏离，只是**你自己不是目标用户**。那就停止用你的 Claude Code 工作流去检验它，另起一个小工具解决你个人的 P1/P3/P4/P5。

**方向 C：冻结重资产，先补最小闭环。**
不换平台、不重写，只做三件一周内可交付的事：
1. 一个只读脚本：扫描 `xkw_workspace/*/openspec/changes/<name>`，输出「同名变更 × 仓库 × 任务完成度 × 最近提交」，解决 P3；
2. 审查结论落盘模板（`review.md`：severity/file/line/status/verifier），解决 P2；
3. 归档前核验脚本：目录是否真的移动、delta 是否同步、主 spec 是否可 validate，解决「手工 mv」。
这三件都不依赖 DSH，可以直接在 Claude Code 里以 skill/slash command 使用。

### 5.2 明确建议冻结/砍掉

- 过程度量（metrics）、控制带（bands）、判断层（decision layer）：一周零诉求，数据源只有 WorkMate 自己；
- 知识图谱可视化面板：GitNexus 已有图，价值重叠；
- 八态生命周期与审批流：单人场景下是纯开销，保留「提案 + 审查 + 归档」三态足够；
- 把「团队审批 / 写码者不得批准」降级为可选项。

### 5.3 一句话判断

> WorkMate 没有偏离「变更提案」这个主题，它偏离的是**你工作时所在的那台机器、那个仓库边界，以及你最痛的那三个时刻**（范围定不下来、审查收不了口、验证出不了仓库）。

---

## 6. 口径与局限

1. 只分析了 `~/.claude/projects` 的**顶层会话**；30 个子代理转录只用于统计调用与角色，未逐条计入指令数。
2. 「13.7 亿 token」按 10-11 之后的 assistant usage 字段求和；「$889」来自会话 cost-state 累计快照，不能精确归因到单日。
3. 会话横跨数天，部分会话起始于 9 月；所有按日统计均以记录时间戳过滤到 10-11 之后。
4. 「痛点」是从**行为证据**（重复、打断、纠正、报错、手工操作）推断的，不是用户自述；引用均来自对话原文。
5. WorkMate 侧事实取自本仓库 `AGENTS.md` / `docs/DESIGN.md` / `~/.dsh/workmate/proposals.json`，未修改任何代码。
