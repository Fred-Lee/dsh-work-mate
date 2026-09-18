## 1. 出站调用扫描（memory-topology）

- [x] 1.1 新增 `scan-outbound.ts`:定义 `OutboundCall`(含 `evidence{file,line,kind}`)与 `scanOutboundCalls(localPath, options?)`
- [x] 1.2 实现 Java 侧识别:`RestTemplate`、`WebClient`、`@FeignClient`(name/value + 接口方法 `@*Mapping`)、`HttpClient`
- [x] 1.2b **占位符键解析(本机真实形态,最高优先)**:从 `name = "${...config.<svc>.name}"` 的键中段导出目标名;解析配置值作为补充证据;不可解析时保留键名线索并标注「值未解析」
- [x] 1.2c 单测(用真实形态作 fixture):占位符键导出 `internal-bc-es`;配置值进入证据;配置缺失时保留线索
- [x] 1.3 实现 JS/TS 侧识别:`axios.*`(含 `axios.create({baseURL})`)、`fetch`、`http.get/post`;模板插值归一为占位符形态
- [x] 1.4 实现基址/配置线索采集:`*.base-url`/`*.url`/`*.host`、`.env`、YAML 嵌套与扁平、k8s DNS 与 `http://<svc>:<port>`;线索附来源文件 + 键名
- [x] 1.5 复用 `scan-rest` 的资源上限与 root containment(`SCAN_LIMITS`/`SCAN_SKIP_DIRS`/`assertScanRoot` 已导出共用);全程不发起网络请求
- [x] 1.6 单测:Feign(名称+路径)、模板归一、配置键、k8s DNS、文件数上限截断、路径逃逸被拒、符号链接环不跟随

## 2. 候选推导（memory-topology）

- [x] 2.1 新增推导模块:`deriveDependencies(topology, options?) → { candidates, scannedAt, scanned, skipped }`
- [x] 2.2 名称档匹配(高):目标服务 id/name 或占位符键段命中 → 服务级候选
- [x] 2.3 路径档匹配(中):先精确,再按段形状归一化(共 4 档,方法一致优先);命中时带端点作为明细;前缀未解析时只按方法级匹配并标注
- [x] 2.4 候选按 (from,to) 合并(证据与端点并集、置信度取高),排除自环;**无证据不产出候选**
- [x] 2.4b **未登记目标不丢弃**:置 `targetDeclared: false` 并可「登记并确认」——真实仓库 7 条 Feign 依赖里 6 条目标未登记
- [x] 2.4c 单测:未登记目标标记正确;已登记目标 `targetDeclared: true`
- [x] 2.5 标记会与既有图成环的候选(`wouldCreateCycle`),与 `checkGraph` 结果一致
- [x] 2.6 单测:各档匹配与证据、合并、自环排除、无证据不产出、成环标记、`scannedAt`

## 3. 服务面与确认落库

- [x] 3.1 服务面新增**只读**候选入口 `deriveDependencies(group, opts?)`,不改拓扑
- [x] 3.2 服务面新增 `applyCandidates(group, candidates[])`,经统一 `persist()` 汇聚点复用 `mergeDependencyEdge`/保存去重;`register:true` 可在同一次动作里登记未登记目标
- [x] 3.3 单测:推导无副作用(文件字节不变);确认已存在服务对 → 行数不变、明细并入;批量确认后一对仍只一条;登记后无悬空;非法输入报错

## 4. UI：推导候选区块（ui-dashboard）

- [x] 4.1 「🔍 推导候选」区块:逐条 `from ──▶ to` + 高/中徽标 + 证据列表(文件:行 · 明细 · 备注)+「目标未登记」+「将形成环」+「已存在(将并入明细)」
- [x] 4.2 逐条确认/忽略 +「✅ 全部确认(不含成环项)」;确认后依赖行即时更新且不重复
- [x] 4.3 路由 `GET api/topology/derive` / `POST api/topology/apply-candidates`,语义与 health 路由一致(旧服务 `available:false`、插件未挂载 404)
- [x] 4.4 单测:渲染/证据/徽标、批量载荷与行更新、逐条确认(含登记)、悬空提示闸门、忽略、`available:false`

## 5. 文档与验证

- [x] 5.1 `docs/USAGE.md`:推导流程、两档置信度、未登记目标、成环候选、漏报如何手工补、两条路由
- [x] 5.2 `docs/ARCHITECTURE.md`:推导职责与边界(纯静态/离线/只提议)、与成对去重 + 体检的组合
- [x] 5.3 `docs/VERIFICATION-GUIDE.md` §3.7:可复现步骤(含实测输出)
- [x] 5.4 全仓 `pnpm typecheck && pnpm test` 通过;`git status` 仅触及本变更文件
- [x] 5.5 真机冒烟(父对话,真实仓库 `homework-server` / `internal-homework`):候选 12 条,与人工认知一致(`homework-server` → internal-base/internal-bc-es/internal-format-factory/internal-homework/internal-qp/internal-ugc/zujuan-ip-api;`internal-homework` 同样依赖前 5 个);证据指向真实 `*Client.java` 与配置文件;冒烟后拓扑已备份还原(指纹一致)

## 6. 真机冒烟暴露的缺陷修复（父对话）

- [x] 6.1 **空值配置被当作"未解析"**:真实 `path:` 为空(Spring 常见),`flattenYaml` 丢弃 null 子节点 → 每条 Feign 线索都带误导性「值未解析/前缀未解析」(实测 137/137)。修:`flattenYaml` 输出空串、`buildConfigIndex` 索引"存在但为空"、备注改说「前缀为空」;并修备注文案改为报出**实际失败的键**(原先固定打印 name 键)
- [x] 6.2 **Feign 前缀被空 path 覆盖**(修复 6.1 时引入并自查发现):`pathValue ?? urlPath` 在空串时不回退,导致调用路径被截短(`/12091/.../homework/class/list` → `/class/list`)。按 Feign 语义改为 `joinPaths(urlPath, pathValue)`
- [x] 6.3 **`scan-rest` 把 Feign 客户端接口当成暴露端点**:客户端接口的方法带 `@GetMapping`,被计入"对外端点"。实测 `homework-server` 端点 220 → **129**(清掉 91 个幻影),`internal-homework` 121 → 111;并因此让推导产出一条**假阳性**候选(拿 A 的出站路径去匹配 B 的幻影端点)。修:含 `@FeignClient` 的文件按出站契约处理,不计入暴露端点
- [x] 6.4 为 6.1–6.3 各补回归测试(空值 → 报「前缀为空」且保留 url 前缀;空设置不单独成线索;Feign 接口不被计为端点),`packages/memory-topology` 102 测试通过
- [x] 6.5 修复效果真机复验:重扫后候选 **13 → 12**(假阳性消失),误导文案 **137 → 0**