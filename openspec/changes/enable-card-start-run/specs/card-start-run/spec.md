## ADDED Requirements

### Requirement: 看板第 ③ 列可发起执行
当卡片具备 `repoScope.projectGroup` 且该群已安装至少一个 agent 时,看板 SHALL 在第 ③ 列卡片
下方渲染「▶ 发起执行」入口;不满足时 SHALL 不渲染该入口(改用「先去执行看板发起」引导)。

#### Scenario: 满足时显示入口
- **WHEN** 卡片具备 `projectGroup` 且该群至少一个 agent 已安装
- **THEN** 第 ③ 列卡片下方出现「▶ 发起执行」按钮

#### Scenario: 不满足时仅显示引导
- **WHEN** 卡片缺少 `projectGroup` 或该群没有任何已装 agent
- **THEN** 不显示入口,显示「请先在执行看板发起」之类的引导

### Requirement: 智能 agent 选择(默认推荐,可在发起前改)
发起对话框 SHALL 提供「按场景自适应(默认)/ claude / codex」三选项。**默认"按场景"**的推荐规则:
- 任务含可拆解要素(子任务/多步/计划型)→ claude
- 任务含多个可并行独立完成的工作 → codex
- 简单/单步任务 → 选当前已装 agent 中**速度最快**者(经 `OrchestratorService.checkAgents()` 推断)
用户 SHALL 可在对话框内**直接勾选/换成 claude 或 codex**,选择不经过任何自动决策。

#### Scenario: 默认"按场景"
- **WHEN** 卡片描述为"拆解为 N 个子任务"
- **THEN** 默认勾选 claude;用户可改

#### Scenario: 用户主动改
- **WHEN** 用户在对话框内把"按场景"切换为"codex"
- **THEN** 提交时使用 codex,系统不再回退到自适应

#### Scenario: 简单任务
- **WHEN** 任务提示简短(无子任务/无显式并行)
- **THEN** 默认选"按场景"下推荐的最快已装 agent

### Requirement: 预填与"级联注入"
发起对话框 SHALL 预填:
- 标题(来自卡片标题,可改)
- 提示词骨架(来自卡片 `summary`,可改;无 `summary` 时给个空 textarea)
- 「级联注入拓扑」复选框(默认勾上)

#### Scenario: 预填
- **WHEN** 卡片标题「实现检索」+ `summary: "为 A、B 设计查询接口"`
- **THEN** 标题框预填「实现检索」,提示词骨架预填该 summary,级联勾上

### Requirement: 只发起、不复制操作
发起动作 SHALL 调既有 `runParallelTask` 工具,run 起后 SHALL:
- 卡片**原地不动**(自动被新增 run 挂到 `runs[]`)
- 卡片内的 run 面板经 SSE 实时显示(复用 change A 的持久化时间线+游标续传)
- 取消/重试/审批/合并等操作**仍在执行看板**完成——看板"发起"是入口,不做第二份操作面板

#### Scenario: 取消仍去执行看板
- **WHEN** 用户需取消一个正在跑的 run
- **THEN** 看板只提供跳转到「执行看板」的链接,取消操作在那里完成

### Requirement: WIP 不拦"列内追加 run"
系统 SHALL 只在"进第 ③ 列"时拦截 WIP(冲突域已饱和时拒绝);**已在第 ③ 列的卡片再发起 run SHALL
不受 WIP 限制**——避免日常迭代被自己设的瓶颈堵死。

#### Scenario: 列内再发起
- **WHEN** 卡片已在第 ③ 列,同域已满
- **THEN** 卡片内"发起执行"按钮仍可用(创建新 run 不被 WIP 拦)

### Requirement: 起跑后把 run 关联回卡片
run 成功创建后,系统 SHALL 把该 run 关联到发起它的卡片(`board.associate(id, {type:'run', refId:taskId})`),
使卡片的 `runs[]` 与卡片内 run 面板能看到它。**这是本能力唯一被允许的看板写入**——它只把已存在的 run
挂到卡片上(不改阶段、不改门、不改 WIP、不写依赖)。关联失败 SHALL NOT 回滚已起跑的 run,
而是按既有的"拒绝即如实报告"约定返回可见原因(卡片可稍后手工重关联)。

#### Scenario: 关联使卡片看到该 run
- **WHEN** 从卡片发起并按后端返回拿到 taskId
- **THEN** 该 taskId 出现在卡片的 `runs[]`(关联写入 `type:'run'`)

#### Scenario: 关联失败不吞掉 run
- **WHEN** 关联调用失败(看板服务不可用等)
- **THEN** 仍返回已起跑的 taskId 与失败原因,卡片阶段不变,不回滚 run

### Requirement: 不改动其余任何数据
发起动作 SHALL NOT 修改依赖图、声明文件、忽略清单、卡片阶段/门/WIP;除上述"关联 run"这一处外
SHALL NOT 写入看板存储。run 本身的持久化走既有历史/审计/产物通道(change A/C/D 复用)。

#### Scenario: 发起不污染状态
- **WHEN** 用户点「▶ 发起执行」
- **THEN** 拓扑文件、声明文件、忽略文件、卡片阶段与门均不变;看板存储仅新增一条 run 关联

