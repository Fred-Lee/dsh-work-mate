## 背景(Context)

`ProjectTopology.restDependencies` 是 `Record<fromServiceId, RestDependencyEdge[]>`,每条边
`{ toServiceId, endpoints: string[], method: string, critical? }`,即"一对 (方法, 端点) = 一条边"。
配置页(`packages/ui-dashboard/src/client/App.tsx` 的 `DependencyModal`)每次保存追加一条,
`applyTopology` 里 `rest[from] = [...(rest[from] ?? []), edge]` **无条件追加**,因此同一对服务
重复添加会堆出重复行。

本机实测的数据规模:`作业服务群` 下有 `internal-homework`(121 端点)与 `homework-server`(220 端点),
依赖边为空。按现有粒度,"homework-server 调用 internal-homework"要按端点数量录几十上百次。

消费者盘点(见 proposal 的表格)表明端点明细只被两处展示逻辑使用:配置页那一行与
`describeTopology` 注入文本。`knowledge-tolaria` 的 `TopologyGraphInput` 只取 `{from,to,critical?}`;
`ui-board` 的影响服务候选只看 `services[].localPath`;`computeDownstream`/`cascadeOrder` 只用 `from`/`to`。

`computeDownstream` 已有 `cyclic` 标志,`cascadeOrder` 遇环降级为发现顺序——环检测能力已存在,
只是定位为"任意有向图的兜底"。用户明确其架构不应有环,故本变更把它升级为不变量体检。

## 目标 / 非目标(Goals / Non-Goals)

**目标:**
- 表达"A 调用 B"只需一次录入、占一行;端点明细变成可选补充。
- 同一对服务只有一条边;保存幂等。
- 无明细时所有展示点优雅降级,不出现残缺文本。
- 环/悬空引用/孤立服务作为体检项报出,让"不该有环"成为可校验的架构约定。

**非目标:**
- 不引入 `serviceDependencies` 新字段(避免双写与迁移)。
- 不改 `critical` 语义(级联优先级,与端点粒度无关)。
- 不自动推导依赖边(出站调用扫描是后续独立增量)。
- 不做可视化图形渲染(仍是列表 + 体检告警)。

## 决策(Decisions)

### D1. 用"空明细 + method `'*'`"表达服务级边,而不是新字段
服务级边编码为 `{ toServiceId, endpoints: [], method: '*' }`。
- **理由**:结构上零迁移——`endpoints: string[]` 允许空、`method: string` 允许 `'*'`;四个消费者
  都不因该形态失效(图谱只用 from/to;影响面只看 services;级联只用 from/to)。
- **替代**:新增 `serviceDependencies: Record<from, string[]>`。否决:与 `restDependencies` 双写,
  要迁移存量,且要同步改 4 个消费者 + 导出/导入 + 看板,收益仅"语义更纯"。
- **注意**:归一化(`normalizeTopology`)当前对缺失字段有填默认的倾向,必须确保它**不把空明细
  填成 `GET`/占位路径**,否则 D1 失效。这是实现的首要验收点。

### D2. 去重键 = (from, to),明细在其内二次去重
`persistDependencies` 语义:同一对服务至多一条边;再次添加时合并明细,明细按 (method, endpoint)
去重。**去重放在服务端(归一化/保存路径)** 而不只在前端:
- **理由**:配置页只是写入口之一(还有导入、未来的推导候选、直接改 YAML/HTTP);服务端去重才能保证
  "同一对只有一条边"这一不变量对**所有**写入路径成立。前端去重只是体验优化。
- **替代**:仅前端去重。否决——导入或直接调 API 仍能造出重复行。

### D3. 环检测升级为"体检",并在保存后呈现
新增图级检查(建议 `graph-health.ts`):`checkGraph(topology) → { cyclic, cycles: string[][],
dangling: Array<{from,to}>, isolated: string[] }`。经由拓扑服务面暴露(如 `checkHealth(group)` 或
在 `loadTopology` 旁加只读方法),dashboard 增加只读路由,配置页保存后拉取并以告警条呈现。
`computeDownstream.cyclic` 与 `cascadeOrder` 的降级行为**保持不变**(体检是新增视角,不是替换)。
- **理由**:用户把"无环"当作架构约定,那么环就是配置错误而非需要优雅降级的输入。保留降级是为了
  不让引擎在脏数据下崩,但**同时**要显式告诉人。
- **替代**:把环变成硬错误、拒绝保存。否决——会挡住"边加边整理"的正常过程;告警更合用。

### D4. 展示降级规则(逐点收口)
- 配置页行:无明细 → `A ──▶ B`;有明细 → 保留现有 `A ──method path──▶ B`。
- `describeTopology`:无明细 → `- A --▶ B`(而非 `- A --*--> B ` 带尾随空格)。
- YAML 导出:沿用现有序列化(空数组与 `'*'` 本身就是合法 YAML),不做特殊分支。
- **理由**:两处展示点是唯一读明细的地方(proposal 表格),漏改会直接产生丑陋残缺文本。

## 风险 / 取舍(Risks / Trade-offs)

- [归一化把空明细"修好"成默认值] → D1 的首要验收点,单测直接断言往返后仍为服务级形态。
- [存量拓扑里已有重复对] → 体检可报"重复对"或保存时静默合并;选择:保存时合并 + 体检不报(避免噪声),
  实施时在 design 记录该取舍已在 tasks 里体现。
- [服务级边导致 cascade 精度下降] → 级联顺序只用 from/to,精度不受影响;`critical` 仍可标注。
- [体检在超大图上开销] → 图规模是服务级(几十到几百节点),DFS 足够;不做跨群分析。

## 迁移计划(Migration Plan)

纯增量兼容:新形态边与旧形态边共存,无需数据迁移。落地顺序:类型/归一化 → 去重写入路径 →
图级体检 → UI 表单与展示 → orchestrator 注入文本 → 文档。回滚 = 还原 UI 与归一化;数据不受损。

## 开放问题(Open Questions)

- 体检入口命名:`checkHealth(group)` 还是并入 `loadTopology` 返回体?倾向独立只读方法(不改既有返回形状)。
- 是否需要在配置页提供"一键清理重复对"?倾向不必(保存即合并),留待有实际脏数据时再说。
