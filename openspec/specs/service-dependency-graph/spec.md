# service-dependency-graph Specification

## Purpose
TBD - created by archiving change simplify-service-dependencies. Update Purpose after archive.
## Requirements
### Requirement: 服务级依赖边（端点明细可选）
系统 SHALL 支持只声明"服务 A 调用服务 B"而不给出 HTTP 方法与端点路径的依赖边:边 SHALL 允许
`endpoints` 为空数组且 `method` 为 `'*'`(未细分接口),归一化过程 SHALL 保留该形态而 NOT 强填默认值。
系统 SHALL NOT 要求用户为每对服务逐条录入端点才能完成依赖声明。

#### Scenario: 只声明服务对即可完成依赖
- **WHEN** 用户在「添加依赖」中只选择调用方与被调用方并保存(不填方法/端点)
- **THEN** 依赖图中出现一条 `A → B` 的边,`endpoints` 为空、`method` 为 `'*'`,无需其他字段

#### Scenario: 带明细的边仍然可表达
- **WHEN** 用户填写了方法与端点路径
- **THEN** 该边保留明细(`endpoints` 含该路径),并作为同一对服务那条边的明细之一,而不是另起一对

#### Scenario: 归一化不破坏服务级形态
- **WHEN** 一份含 `endpoints: []`、`method: '*'` 的拓扑被保存后重新加载
- **THEN** 该边仍为服务级形态(不被填入默认 `GET` 或占位端点)

### Requirement: 按服务对去重
系统 SHALL 以 (fromServiceId, toServiceId) 为键对依赖去重:同一对服务 SHALL 只存在一条边,
再次添加 SHALL 把新明细并入该边,并 SHALL NOT 产生重复的边行。明细内部 SHALL 同样去重
(同一 (method, endpoint) 组合不重复)。

#### Scenario: 重复添加同一对不产生新行
- **WHEN** 已存在 `A → B` 的边,用户再次添加 `A → B`(无论是否带明细)
- **THEN** 边数保持为一条,界面仍只显示一行;带明细时该明细被并入既有边

#### Scenario: 明细内部去重
- **WHEN** 对既有 `A → B` 边重复添加相同的 (method, endpoint)
- **THEN** 该明细不重复出现

#### Scenario: 保存同一份拓扑两次是幂等的
- **WHEN** 对同一份拓扑连续保存两次
- **THEN** 第二次不改变依赖集合(不新增重复行)

### Requirement: 无明细时的展示降级
依赖的展示 SHALL 在缺少明细时优雅降级:配置页 SHALL 渲染为 `A ──▶ B`(NOT 出现 `GET ` 或尾随空白的
残缺文本);`describeTopology` 注入 agent 的文本 SHALL 同样退化为 `A --▶ B` 形态。

#### Scenario: 配置页渲染服务级边
- **WHEN** 某边 `endpoints` 为空
- **THEN** 该行显示为 `调用方 ──▶ 被调用方`,不含方法名与空端点

#### Scenario: 注入文本渲染服务级边
- **WHEN** 以 `cascade: true` 发起任务且拓扑含无明细边
- **THEN** 注入的拓扑上下文里该边显示为 `A --▶ B`,不留残缺空白

### Requirement: 图级体检（环作为架构不变量）
系统 SHALL 提供图级检查,报告:(a) **依赖环**(含环内的服务列表)、(b) **指向不存在服务的边**、
(c) **孤立服务**(无任何入边与出边)。检查结果 SHALL 可通过只读接口取回,并 SHALL 在配置页保存后
以告警呈现。既有 `computeDownstream` 的 `cyclic` 语义 SHALL 保留。

#### Scenario: 成环被报出
- **WHEN** 声明的依赖形成 `A → B → A`
- **THEN** 体检报告列出该环及其成员服务,配置页显示告警(而不是静默降级级联顺序)

#### Scenario: 悬空引用被报出
- **WHEN** 某条边的 `toServiceId` 不在 `services` 中
- **THEN** 体检报告将其列为悬空引用并指出该边

#### Scenario: 孤立服务被报出
- **WHEN** 某服务既无出边也无入边
- **THEN** 体检报告将其列为孤立服务(仅提示,不阻断保存)

#### Scenario: 干净图无告警
- **WHEN** 依赖图为无环且无悬空引用的连通图
- **THEN** 体检返回空问题列表,配置页不显示告警

### Requirement: 单对服务只占一行（可复现验证）
对"两个服务、一对依赖"的最小场景,系统 SHALL 只需一次录入即完成表达,配置页 SHALL 只显示一行。

#### Scenario: 最小场景一次录入
- **WHEN** 用户在只有两个服务的项目群里添加一次"服务 X → 服务 Y"依赖
- **THEN** 依赖拓扑区块显示恰好一行 `X ──▶ Y`,无需任何端点录入

