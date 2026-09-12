## 1. 出站调用扫描（memory-topology）

- [ ] 1.1 新增 `scan-outbound.ts`:定义 `OutboundCall { path: string; method?: string; target?: string; evidence: { file: string; line?: number; kind: 'call' | 'config' | 'feign' } }` 与 `scanOutboundCalls(localPath, options?): Promise<OutboundCall[]>`
- [ ] 1.2 实现 Java 侧识别:`RestTemplate`(exchange/getForObject/postForObject/…)、`WebClient`(uri 字面量)、`@FeignClient`(name/value + 接口方法 `@*Mapping`)、`HttpClient`
- [ ] 1.3 实现 JS/TS 侧识别:`axios.get/post/…`、`fetch(...)`、`http.get/post`;模板字符串插值归一为占位符形态
- [ ] 1.4 实现基址/配置线索采集:`*.base-url` / `*.url` / `*.host` 配置键、`@FeignClient(name=…)`、k8s service DNS 与 `http://<svc>:<port>` 形态;线索附来源(文件 + 键名)
- [ ] 1.5 复用 `scan-rest` 的资源上限与 root containment;全程不发起网络请求
- [ ] 1.6 单测:Feign 调用识别(名称+路径)、`axios.get(\`/api/users/${id}/orders\`)` 归一化、配置键采集、k8s DNS 采集、超限截断、路径逃逸被拒

## 2. 候选推导（memory-topology）

- [ ] 2.1 新增推导模块:`deriveDependencies(topology, options?) → { candidates: Candidate[]; scannedAt: number }`,其中 `Candidate { from, to, confidence: 'high' | 'medium', evidence: Evidence[], endpoints: string[], wouldCreateCycle: boolean }`
- [ ] 2.2 名称档匹配(高):目标服务 id/name 命中调用方基址/配置/Feign 名 → 服务级候选
- [ ] 2.3 路径档匹配(中):调用方路径与目标服务 `apiEndpoints` 匹配——先精确,再按段形状归一化;命中时带该端点作为明细
- [ ] 2.4 候选按 (from,to) 合并(证据与端点并集、置信度取高),排除自环;**无证据不产出候选**
- [ ] 2.5 标记会与既有图成环的候选(`wouldCreateCycle: true`)而不是丢弃
- [ ] 2.6 单测:名称档候选+证据;路径档候选带端点;同一对多线索合并为一条且置信度取高;自环排除;无证据不产出;成环候选被标记;`scannedAt` 存在

## 3. 服务面与确认落库

- [ ] 3.1 服务面新增**只读**候选入口(如 `deriveDependencies(group, opts?)`),不修改拓扑
- [ ] 3.2 服务面新增确认入口(如 `applyCandidates(group, candidates[])`),内部**复用** `mergeDependencyEdge` / 保存去重语义,保证一对服务仍只一行
- [ ] 3.3 单测:推导入口无副作用(拓扑文件字节不变);确认已存在的服务对 → 边数不变、明细并入;批量确认后任意一对仍只一条;确认不会引入重复明细

## 4. UI：推导候选区块（ui-dashboard）

- [ ] 4.1 依赖拓扑区块新增「🔍 推导候选」入口与结果区:逐条显示 `from ──▶ to`、置信度徽标(高/中)、证据列表(文件/配置键/匹配端点)、成环标记
- [ ] 4.2 支持逐条确认/忽略与「全部确认(不含成环项)」;确认后依赖行即时更新且不出现重复行
- [ ] 4.3 `api.ts`:新增只读候选路由与确认路由(如 `GET api/topology/derive?group=`、`POST api/topology/apply-candidates`),转发到拓扑服务
- [ ] 4.4 单测:候选渲染(含证据与置信度徽标、成环项默认不勾选)、确认调用形状、路由转发与错误语义

## 5. 文档与验证

- [ ] 5.1 `docs/USAGE.md`:推导流程(点「推导候选」→ 看证据 → 确认)、两档置信度含义、成环候选如何处理、漏报如何手工补录
- [ ] 5.2 `docs/ARCHITECTURE.md`:推导职责与边界(纯静态、离线、只提议不落库)、与 `service-dependency-graph` 的合并语义关系
- [ ] 5.3 `docs/VERIFICATION-GUIDE.md`:可复现步骤——在一个含 `@FeignClient` 或 `axios` 调用的临时仓库上跑推导,核对候选与其证据;确认后核对依赖仍只一行;构造成环候选核对标记
- [ ] 5.4 全仓 `pnpm typecheck && pnpm test` 通过;`git status` 仅触及本变更文件
- [ ] 5.5 真机冒烟(父对话执行):对 `homework-server` / `internal-homework` 跑一次推导,核对候选与证据是否与人工认知一致;确认后检查依赖拓扑区块行数与体检结果
