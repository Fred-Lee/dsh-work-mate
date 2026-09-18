## Why

声明一条服务间依赖,现在必须给出一对 (HTTP 方法, 端点路径),而模型是按 `fromServiceId` 挂一串边——
于是"A 调用 B"这一件事要按端点数量重复录 N 次。实际使用中端点往往几十上百个(本机两组服务的实测:
`internal-homework` 121 个、`homework-server` 220 个端点),用户无法也无意逐个列出 HTTP 方法。

核对全部消费者后发现这种粒度是**错配**的:真正做事的消费者只用"谁指向谁"。

| 消费者 | 实际读的字段 |
|---|---|
| `knowledge-tolaria` 知识图谱 | 仅 `{from, to, critical?}`——其 `TopologyGraphInput` 根本没有 method/endpoints |
| `ui-board` 影响服务候选 | 完全不读依赖边,只用 `services[].localPath` 做文件命中 |
| `computeDownstream` / `cascadeOrder` | 仅用 `from` / `to`;`endpoints` 只是透传 |
| YAML 导出/导入 | 整体对象往返 |
| 仅两处用明细 | `describeTopology` 注入 agent 的提示词文本;配置页那一行的显示 |

同时确认了一个现成缺陷:添加依赖是**无条件追加**(`rest[from] = [...rest[from], edge]`),同一对服务
重复添加会堆出重复行,而语义上那只是一条边。

另外用户明确其架构**不应存在循环调用**,因此环检测不该只是"级联顺序降级"的兜底,而应升级为
**架构不变量的体检**:声明出的图若成环,直接作为配置问题报出来。

## What Changes

- **服务级依赖边**:`RestDependencyEdge` 允许 `endpoints: []` + `method: '*'`,表示"A 调用 B"但未细分接口;
  端点明细降级为**可选**信息。归一化保留该形态(不再要求补默认值)。
- **按 (from, to) 去重**:同一对服务的第二次添加不再新增一行,而是把明细**挂到既有边**上
  (去掉重复的 (method,endpoint) 组合);纯服务级边与带明细边共存于同一对。
- **表单简化**:「添加依赖」默认只需两个下拉(调用方 / 被调用方)即可保存;HTTP 方法与端点路径移入
  可折叠的「端点明细(可选)」区。
- **展示优雅降级**:无明细的边渲染为 `A ──▶ B`(不再出现 `GET ` 这种残缺文本);`describeTopology`
  注入文本同样退化为 `A --▶ B`;YAML 导出保持往返。
- **环检测升级为体检**:新增图级检查(成环、指向不存在的服务、孤立服务),在配置页保存后以
  告警呈现;`computeDownstream` 的 `cyclic` 语义保留,并新增可单独调用的检查入口。
- 不新增 `serviceDependencies` 字段:细节降级即可满足需求,避免双写、迁移与四处消费者同步改动。

## Capabilities

### New Capabilities
- `service-dependency-graph`:服务间依赖的声明与体检——服务级边(明细可选)、按服务对去重、无明细时的展示降级,以及把环/悬空引用/孤立服务作为架构不变量问题报出的图级检查。

### Modified Capabilities
<!-- 无:既有已归档 spec 不涉及拓扑模型。 -->

## Impact

- `packages/memory-topology`:边类型与归一化(`types.ts`)、服务面新增检查与去重辅助(`index.ts`)、
  图级体检(`downstream.ts` 或新 `graph-health.ts`)、YAML 渲染(`yaml.ts`)。
- `packages/ui-dashboard`:`DependencyModal` 表单简化与明细折叠、依赖行渲染降级、
  保存路径去重(`client/App.tsx`)、体检结果呈现(`api.ts` 新增/扩展只读检查路由)。
- `packages/orchestrator`:`describeTopology` 在无明细时优雅渲染(`core.ts`)。
- 文档:`docs/USAGE.md`(依赖录入流程)、`docs/ARCHITECTURE.md`(模型说明)、
  `docs/VERIFICATION-GUIDE.md`(新增可复现验证步骤)。
