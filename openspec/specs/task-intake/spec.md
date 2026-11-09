# task-intake Specification

## Purpose
TBD - created by archiving change adopt-superagent-openspec-source. Update Purpose after archive.
## Requirements
### Requirement: 面板四列与状态唯一来源

WorkMate 面板 SHALL 以「任务」为主视图，至少提供四列：`待办`、`执行中`、`需要我`、
`已完成`。任务卡 SHALL 至少显示标题、仓库、优先级、分支（若有）、最后更新时间与阶段。

列归属 SHALL 按以下规则确定，SHALL NOT 由前端自行推断：

- `tasks.json` 有记录、`assigned=false` 或 `abandoned=true` → `待办`；
- 已产生 Trigger 且无 Ticket / Ticket 处于 `working` 或 `idle` → `执行中`
  （`idle` 的子状态为"等待触发"）；
- Ticket 处于 `person / answer`、`person / review`、`person / blocked`、
  `person / failed`、`person / delivery` → `需要我`；
- Ticket 已结束（`completed` / `merged` / `closed` / `dropped` / `stopped` 五值全部覆盖）
  → `已完成`（子状态分别为"已完成 / 已合并 / 已关闭 / 无需处理 / 已停止"）。
  待办被标记放弃时，若已有结束的 Ticket 则归 `已完成`（子状态"已停止"），
  否则回到 `待办`（可重新打开）。

同一待办 SHALL 只属于一列：按"先看 Ticket 终态，再看 tasks.json 标记"的顺序取第一个
匹配项，SHALL NOT 同时出现在两列（方案门的"执行完成待批准"用来源标签表达，
不重复占列）。

判定 SHALL 先看 `ended`：Super-agent 的 `ticketStage` 把 `ended` 作为第一分支
（`src/core/stage.ts:10`），漏掉它会把已结束的 Ticket 误判成执行中。

侧栏徽标 SHALL 显示 `需要我` 数量，SHALL NOT 显示"待办总数 + 执行中"这类会与列计数
打架的复合数字。

#### Scenario: 需要我合并五类等待

- **WHEN** 一个 Ticket 等待回答、另一个等待验收
- **THEN** 两者都出现在「需要我」，且各自显示"待回答"/"待验收"

#### Scenario: 无 Ticket 不假装完成

- **WHEN** 待办已指派但尚未产生 Ticket 或 Ticket 读取失败
- **THEN** 卡片显示「已投递评估」或 `unknown` 与原因，不显示「已完成」

### Requirement: 治理门与执行等待同列

「需要我」SHALL 同时容纳两类等待，并以来源标签区分：

- **执行器等待**：Ticket 的 `person/*` 阶段（待回答、待验收、受阻、投递失败），
  状态来自 Super-agent；
- **方案门**：关联提案的 G2（待确认方案）与 G5（待批准合并归档），状态来自 WorkMate。

两类卡的**主按钮** SHALL 不同：执行器等待是"回答 / 去验收 / 重试"，方案门是
"确认方案并投递 / 合并并归档"。同一列内 SHALL NOT 用同一个动词覆盖两类动作。

方案门 SHALL 在 `已完成` 之外单独计数；当某任务的 Ticket 已结束但提案仍停在门前时，
该任务 SHALL 同时出现在「已完成」与「需要我（方案门）」，并以来源标签说明"执行完成、
待你批准"。SHALL NOT 因为 Ticket 结束就把方案门隐藏。

#### Scenario: 执行完成但方案未批

- **WHEN** 某任务的 Ticket 已 `ready` 结束，而提案的 G5 尚未批准
- **THEN** 该任务在「已完成」显示"执行完成"，并在「需要我」出现"合并并归档"的方案门卡片

#### Scenario: 两个来源的等待不混动作

- **WHEN** 同时有 worker 提问与 G2 待确认
- **THEN** 两张卡的主按钮分别是"回答"和"确认方案"，不出现"统一处理"之类的合并动作

### Requirement: 新建待办与三种写入方式

面板 SHALL 提供新建待办表单，至少包含：目标（一句话）、仓库、基线分支、验收标准、
优先级、执行方式。执行方式 SHALL 提供 `指派给 Super-agent`、`生成 OpenSpec 提案`、
`仅记录`。

`指派给 Super-agent` SHALL 写入 `tasks.json` 并置 `assigned=true`；`生成 OpenSpec 提案`
SHALL 调用既有的提案创建能力并**不**置 `assigned`；`仅记录` SHALL 只写 `tasks.json`。
所有方式 SHALL 使用同一份表单与同一套服务端校验；SHALL NOT 使用 `window.prompt`。

`createdBy` SHALL 记录创建者标识；缺省时 SHALL 使用配置的默认操作者
（`workmate:panel`），并 SHALL 在首次使用时提示把它加入 Super-agent 的 allowed 列表。

#### Scenario: 三种方式落点不同

- **WHEN** 用户分别以三种方式创建同一目标
- **THEN** 前两条在 `tasks.json` 中 `assigned=true`，第三条 `assigned=false`；
  第二条同时出现 OpenSpec 变更目录

#### Scenario: 三个子状态可区分

- **WHEN** 用户指派后分别截取"面板已写入""Source 已投递""Ticket 已创建"三个时刻
- **THEN** 卡片依次显示"已记录·待扫描 / 已投递·待接受 / 执行中"，每个转换都有服务端事实来源

#### Scenario: 空目标被拒

- **WHEN** 目标为空时提交
- **THEN** 表单就地显示错误，不写文件

### Requirement: 指派、回答、停止的动作映射

面板 SHALL 提供且只提供以下写到任务文件的动作：

- `指派`：把 `assigned` 置 `true` 并递增 `attempt`；SHALL NOT 直接调用 Super-agent 的
  任何接口；
- `回答`：把人的回答追加到 `inputs.jsonl`（面板独占的单写者文件，
  `{ taskId, text, by, at, seq }`），Source 读取未消费的行并在同一 Thread 上产生 Trigger；
- `重试`：递增 `attempt` 并置 `assigned=true`，由 Source 产生新 Trigger；
- `停止`：置 `abandoned=true`，Source 不再为该待办产生 Trigger，并调用 Super-agent 的
  stop 结束正在执行的 Ticket；
- `放弃`：仅置 `abandoned=true`，不调用 stop；
- `重新打开`：把 `abandoned` 置回 `false` 并保留 `attempt`（不递增），使下一个扫描周期
  重新产生当前 attempt 的 Trigger；SHALL NOT 复活已结束的 Ticket，而是新建一次尝试。

`指派`/`重试` SHALL 先把 `abandoned` 置 `false` 再递增 `attempt`；
`attempt` SHALL 初始为 `0`，首次投递为 `1`，Trigger ID 为 `workmate:<taskId>:<attempt>`。

三份文件 SHALL 各有唯一写者：`tasks.json`（面板）、`inputs.jsonl`（面板）、
`tasks.jsonl`（Source）。SHALL NOT 有文件被两端同时写入。

动作成功 SHALL 写 `events.jsonl`；动作失败 SHALL 在卡片或抽屉内就地显示服务端错误，
SHALL NOT 只在页面其他位置提示。

#### Scenario: 回答不重走 Eval

- **WHEN** 用户在「需要我」卡片提交回答
- **THEN** 回答作为该 Thread 的人消息被投递，worker 在下一步读到；不产生第二张 Ticket

#### Scenario: 停止后不再产生 Trigger

- **WHEN** 用户停止一条待办
- **THEN** 后续扫描不再为该待办产生 Trigger，Ticket 结束

### Requirement: 任务详情与治理证据

选中任务 SHALL 打开详情抽屉，至少展示：阶段与来源、目标仓库/分支/执行方式/执行器/
验收标准、对话时间线、证据（`TEST.md`、`TEAM-REVIEW.md`、`SUMMARY.md`、commit / PR）、
与阶段匹配的动作条。

抽屉 SHALL 同时提供该待办的**治理状态**（若关联提案）：工件完整性、`planHash`、G2/G5
批准状态。治理状态 SHALL 来自 WorkMate 自己的提案与审批事实，执行状态 SHALL 来自
Super-agent，二者 SHALL 并列显示且标明来源。

#### Scenario: 一次点击看到全貌

- **WHEN** 用户点击任意任务卡
- **THEN** 抽屉直接展示执行阶段、治理状态、对话与证据，无需二次加载

#### Scenario: 缺失字段不伪造

- **WHEN** 任务没有分支、提案或证据
- **THEN** 抽屉显示"未创建 / 无关联提案 / 暂无证据"，不显示编造值

### Requirement: 首次使用与配置可见性

面板 SHALL 在以下任一条件成立时，于首屏显示一条可关闭的 setup 提示，并给出可复制的内容：
来源未安装、`taskFile` 两侧路径不一致、操作者不在 `policy.allowed`、`interactive=false`。

提示 SHALL 说明三件事：谁可以指派（allowed 列表）、指派后由谁判断（Super-agent 的 Eval，
explicit 强度不要求写规则）、以及"从现在起会发生什么"（`interactive=false` 时只是记录）。
提示 SHALL NOT 阻塞建待办；SHALL 在条件全部满足后自动消失并不再出现。

侧栏状态卡 SHALL 常驻显示：执行器连通性、`interactive` 开关状态、以及规则/准入是否就绪。
状态 SHALL 来自实际探测，SHALL NOT 由前端假设为正常。

#### Scenario: 准入未配置时先告知

- **WHEN** 操作者不在 allowed 列表
- **THEN** 首屏显示可复制的加入步骤；指派按钮仍可用，但结果会是"被忽略"并显示原因

#### Scenario: 只读模式下明说

- **WHEN** `interactive=false`
- **THEN** 状态卡显示"只读 · 不投递"，已指派的卡片显示"等待执行器开启投递"而非"排队中"

#### Scenario: 条件满足后不再打扰

- **WHEN** 三项条件全部满足
- **THEN** 提示自动消失；之后的会话中不再重复出现

### Requirement: 离线、未知与空态

Super-agent 不可达时面板 SHALL 显示 `offline` 与端点、原因，并保留 `tasks.json` 的待办；
指派 SHALL 仍可写入（意图不依赖执行器），但卡片 SHALL 显示"已记录，执行器离线"，
SHALL NOT 显示"已投递"。

读取 Ticket 失败时 SHALL 显示 `unknown` 与原因，SHALL NOT 回退为"已完成"。

某列无任务时 SHALL 显示该列语义与可选动作，SHALL NOT 留空白页。

#### Scenario: 离线仍能记录意图

- **WHEN** Super-agent 离线时用户新建并指派一条待办
- **THEN** 文件写入成功，卡片显示"执行器离线"，连接恢复后 Source 扫描并产生 Trigger

#### Scenario: 空列有指引

- **WHEN** 「待办」列为空
- **THEN** 显示"没有待指派的条目"与新建入口

### Requirement: 面板契约与窄屏

任务视图 SHALL 注册在宿主 `main` keyed 槽与 `sidebar.panellist`，与既有工作台共用入口；
SHALL 渲染在面板唯一的纵向滚动容器内（根 `height:100%`、纵向 flex、唯一滚动子层），
页头与状态栏 SHALL 在滚动层之外常驻。

窄屏（小于 760px）SHALL 单列；详情抽屉 SHALL 占满宽度并可返回；320px 下 SHALL 无横向
溢出或文字裁剪。

#### Scenario: 窄屏单列

- **WHEN** 面板宽度小于 760px
- **THEN** 四列纵向堆叠，抽屉占满宽度，页头按钮不重叠

#### Scenario: 长内容可滚动

- **WHEN** 某列卡片总高超过可用高度
- **THEN** 内容区出现纵向滚动条，页头保持可见

### Requirement: 键盘与无障碍

主要流程 SHALL 可只用键盘完成：打开卡片、填写并提交新建、提交回答、关闭抽屉。
抽屉 SHALL 在 Escape 时关闭并把焦点返回触发卡片；动态结果 SHALL 经 `aria-live` 播报；
SHALL NOT 添加自定义 `tabindex`。

#### Scenario: 键盘完成回答

- **WHEN** 用户用键盘打开卡片、输入回答并提交
- **THEN** 提交成功，Escape 后焦点回到原卡片

### Requirement: 执行器与仓库一对一

一个 Super-agent 实例 SHALL 只服务一个仓库；面板 SHALL 按待办的 `repo` 决定是否可投递：
`repo` 与该实例配置的仓库一致时才 SHALL 显示可指派，否则 SHALL 显示
「未接入执行器（仓库 X）」且 SHALL NOT 写入 `assigned=true`。

面板 SHALL NOT 通过修改 prepare 命令或环境变量来让一个实例跨仓库执行；多仓库 SHALL 由
多个实例承担，第一期只支持一个实例，第二期才按 `repo` 路由到不同 endpoint。

#### Scenario: 非主仓任务不假装排队

- **WHEN** 提案有 `a`、`b` 两个 target，而只有 `a` 接入了执行器
- **THEN** `b` 的任务显示「未接入执行器」且不可指派；`a` 的任务正常投递

#### Scenario: 同仓任务可指派

- **WHEN** 待办的 `repo` 与实例仓库一致
- **THEN** 卡片提供指派动作，指派后写入 `assigned=true`

### Requirement: 并发写入的分配完整性

同一进程内对待办文件的并发写 SHALL 串行执行：并发新建 SHALL 产出互不相同的
任务 id，并发回答 SHALL 产出连续且不重复的 seq，SHALL NOT 因读改写交错丢失
任何一次写入。id 分派 SHALL NOT 依赖"读到的行数 + 1"在无锁前提下的正确性。

#### Scenario: 同刻并发新建

- **WHEN** 面板与 agent 工具在同一事件循环 tick 内各新建一条待办
- **THEN** 两条记录都落盘且 id 互不相同，Source 为它们派发两张独立 Ticket

#### Scenario: 并发回答 seq 连续

- **WHEN** 对同一条待办并发提交两条回答
- **THEN** `inputs.jsonl` 的两条记录 seq 互不相同且各自单调递增，均被 Source 消费

### Requirement: 面板读路径只读

面板的任务视图与遗留目录查询 SHALL 只读：这些端点的执行 SHALL NOT 修改提案状态、
SHALL NOT 触发提案状态迁移、SHALL NOT 获取提案写锁。

当某提案的全部待办在任务视图显示为完成时，该提案 SHALL 由独立的低频调度器推进到
「待合并」（判据见 `lifecycle-state-machine` 的「实现完成后的自动推进」），
SHALL NOT 依赖面板轮询来触发。

#### Scenario: 轮询不引发状态变化

- **WHEN** 面板以 5 秒间隔连续请求任务视图与遗留目录 3 分钟
- **THEN** 提案状态保持不变（除非调度器独立推进），请求始终在正常时间内返回

#### Scenario: 完成后自动前进

- **WHEN** 某个提案的全部待办均已显示「已完成」
- **THEN** 在一个扫描周期内该提案出现在看板「待合并」列

