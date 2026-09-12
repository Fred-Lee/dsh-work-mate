## Why

服务间依赖目前全靠手工声明。用户的实际处境:两个 Java 后端服务(`internal-homework` 121 个端点、
`homework-server` 220 个端点),`homework-server` 调用 `internal-homework`,但**无法也不愿逐个列出
HTTP 方法**。上一个变更(`simplify-service-dependencies`)把录入降到"两个下拉录一条服务级边",解决了
**表达**问题;但没有解决**发现**问题——人仍然要知道"谁调谁",而服务数量上去后这件事会变成纯体力活。

关键前提已经具备:用户**已经扫描过**各服务的对外端点(341 个),`scan-rest` 能识别 Spring / NestJS /
Express 的**暴露**端点。缺的是另一半——**对外发起**的调用。把两侧对上,依赖边就能被**推导**出来,
人只需要确认。

本变更即补上这一半:扫描出站调用与配置线索,生成**带证据的候选依赖**,由人确认后经上一变更的去重
路径落库。不自动写库——这与本仓既有的"半自动 + 人工确认"取向一致(看板的"影响服务候选"、
合并冲突的人工裁决都是同一模式)。

## What Changes

- 新增 `scan-outbound`(memory-topology):扫描服务的**对外调用**,识别
  `RestTemplate` / `WebClient` / `@FeignClient`(+ 接口方法上的 `@*Mapping`)/ `HttpClient` /
  `axios` / `fetch` 的调用路径字面量,并收集**基址线索**(`*.base-url` 类配置键、Nacos 服务名、
  k8s service DNS、`@FeignClient(name=…)`)。沿用 `scan-rest` 的资源上限与路径约束,不做任何网络请求。
- 新增候选推导(`derive-dependencies`):对每个服务生成候选边,分两档置信度并**必须附证据**:
  - **名称档(高)**:调用方的配置键 / Feign 名 / 基址里出现目标服务的 id 或 name → 服务级候选边。
  - **路径档(中)**:调用方的路径字面量与目标服务已声明端点匹配(先精确,再按段形状归一化,
    如 `/api/users/{id}` ↔ `/api/users/{userId}`)→ 候选边并带上该端点作为明细。
  候选**去重**、**排除自环**;会造成环的候选**单独标出**而不是静默丢弃(环是架构不变量问题,人应当知道)。
- 服务面新增只读候选入口(如 `deriveDependencies(group, opts?)`)返回
  `{ candidates: Array<{from, to, confidence, evidence[], endpoints[]}>, scannedAt }`,**不写库**。
- 确认落库(如 `applyCandidate(group, from, to)` 或批量):复用 `simplify-service-dependencies` 的
  `mergeDependencyEdge` / 保存去重,保证确认候选**不会造出重复行**。
- 配置页呈现:依赖拓扑区块显示「推导候选 (N)」,逐条展示置信度、证据(命中文件/配置键/端点)与
  影响的服务对,支持逐条或全部确认、忽略;确认后依赖行即时更新。
- 新增能力规格 `dependency-derivation`;不改变既有拓扑数据模型的字段。

## Capabilities

### New Capabilities
- `dependency-derivation`:从服务的出站调用与配置线索推导服务间依赖候选——扫描范围与证据采集、两档置信度匹配规则、候选呈现与人工确认落库、以及不写库/不自动合并的边界。

### Modified Capabilities
<!-- 无:候选确认落库复用 service-dependency-graph 的既有行为,不改其要求。 -->

## Impact

- `packages/memory-topology`:新增 `scan-outbound.ts`、`derive-dependencies.ts`(命名待定)与单测;
  `index.ts` 服务面新增只读候选与确认入口。
- `packages/ui-dashboard`:配置页「推导候选」区块与确认交互(`client/App.tsx`)、候选/确认路由(`api.ts`)。
- 文档:`docs/USAGE.md`(推导流程与置信度含义)、`docs/ARCHITECTURE.md`(推导职责与边界)、
  `docs/VERIFICATION-GUIDE.md`(可复现验证步骤)。
- 与 `simplify-service-dependencies` 的依赖关系:本变更**假定其已落地**(复用其去重合并与展示降级);
  实施顺序应在其后。
