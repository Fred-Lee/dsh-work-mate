## ADDED Requirements

### Requirement: 出站调用扫描
系统 SHALL 能扫描一个服务源码树中的**对外 HTTP 调用**,提取调用路径字面量与目标线索,识别范围 SHALL 至少覆盖:
Java 的 `RestTemplate`(exchange/getForObject/postForObject 等)、`WebClient`(uri 字面量)、
`@FeignClient`(注解的 name/value 与接口方法上的 `@*Mapping`)、`HttpClient`;JS/TS 的 `axios.*`、
`fetch(...)`、`http.get/post` 等。扫描 SHALL 沿用既有端点扫描的资源上限(深度/文件数/文件大小)与
路径containment约束,且 SHALL NOT 发起任何网络请求。

#### Scenario: Feign 调用被识别
- **WHEN** 服务源码含 `@FeignClient(name = "internal-homework")` 且接口方法带 `@GetMapping("/api/x")`
- **THEN** 扫描结果为一条出站调用线索:目标线索 `internal-homework`、路径 `/api/x`

#### Scenario: 模板字符串路径被识别
- **WHEN** 代码为 `axios.get(\`/api/users/${id}/orders\`)`
- **THEN** 提取出规范化路径 `/api/users/{}/orders`(或等价占位形态),不因插值而丢弃该线索

#### Scenario: 扫描有界且离线
- **WHEN** 对一个大型仓库执行扫描
- **THEN** 扫描在既有资源上限内结束,且不产生任何网络请求

### Requirement: 基址与配置线索采集
扫描 SHALL 同时收集**目标服务的名称线索**:形如 `*.base-url` / `*.url` / `*.host` 的配置键及其值、
`@FeignClient` 的 name/value、以及 k8s service DNS 形态(`<svc>.<ns>.svc.cluster.local`)或
`http://<svc>:<port>` 形态的基址。线索 SHALL 记录来源(文件路径与键名)以便作为证据展示。

#### Scenario: 配置键被采集
- **WHEN** `application.yml` 含 `internal-homework.base-url: http://internal-homework:8080`
- **THEN** 产出线索:目标候选 `internal-homework`,证据为「application.yml 的 internal-homework.base-url」

#### Scenario: k8s DNS 被采集
- **WHEN** 配置里出现 `http://homework-server.default.svc.cluster.local`
- **THEN** 产出目标候选 `homework-server`,证据指向该配置位置

### Requirement: 候选推导与两档置信度
系统 SHALL 为每个服务生成候选依赖边,并按置信度分档,每条候选 SHALL 附带**证据列表**
(命中文件、配置键或匹配到的端点)。匹配规则 SHALL 包含:
(a) **名称档(高)**——目标服务的 id 或 name 出现在调用方的基址/配置/Feign 名中;
(b) **路径档(中)**——调用方的路径字面量与目标服务已声明端点匹配(先精确匹配,再按段形状归一化匹配,
如 `/api/users/{id}` ↔ `/api/users/{userId}`)。

#### Scenario: 名称档候选
- **WHEN** `homework-server` 的配置含 `internal-homework.base-url`
- **THEN** 生成候选 `homework-server → internal-homework`,置信度为高,证据指向该配置键

#### Scenario: 路径档候选带端点明细
- **WHEN** `homework-server` 调用 `/api/homework/{id}`,而 `internal-homework` 已声明 `/api/homework/{hwId}`
- **THEN** 生成候选 `homework-server → internal-homework`,置信度为中,证据为该路径匹配,并带上匹配到的端点作为明细

#### Scenario: 无证据不产出候选
- **WHEN** 某调用线索既无名称线索也无路径匹配
- **THEN** 不产出候选(不产生无证据的猜测)

### Requirement: 占位符配置键解析
系统 SHALL 从 `${...}` 形态的 `@FeignClient` 属性中导出目标服务线索——包括形如
`name = "${project.feign-client-config.internal-bc-es.name}"` 的写法,取占位符键中标识服务名的那一段
(如 `internal-bc-es`)作为目标名;并 SHALL 尝试从配置文件中解析该键的**值**作为补充证据,
值形如 `http://<svc>:<port>` 或 k8s service DNS 时 SHALL 直接导出目标名。无法解析值时
SHALL 仍产出仅凭键名的名称线索,并 SHALL NOT 因无法解析而丢弃该线索。

#### Scenario: 占位符键导出目标名
- **WHEN** 代码为 `@FeignClient(name = "${project.feign-client-config.internal-bc-es.name}")`
- **THEN** 产出目标线索 `internal-bc-es`,证据为「该占位符键」

#### Scenario: 占位符值可解析时补充证据
- **WHEN** 配置文件中 `project.feign-client-config.internal-bc-es.url` 的值为 `http://internal-bc-es:8080`
- **THEN** 该候选的证据包含该配置键及其值,且目标名与键导出的名字一致

#### Scenario: 值不可解析不丢线索
- **WHEN** 占位符键在配置中找不到对应值(如由 Nacos 下发)
- **THEN** 仍产出基于键名的名称线索,并在证据中标注「值未解析」

### Requirement: 未登记目标候选与登记动作
当候选的目标服务未在拓扑 `services` 中登记时,系统 SHALL 仍然产出该候选,标注 `targetDeclared: false`,
并 SHALL 与已登记目标的候选分组呈现。对这类候选,系统 SHALL 提供**登记该服务**的动作(以候选导出的名字
建服务条目),使确认依赖后 NOT 产生悬空引用。系统 SHALL NOT 以"目标未登记"为由过滤掉候选。

#### Scenario: 未登记目标仍产出候选
- **WHEN** `homework-server` 依赖 `internal-bc-es`,但 `internal-bc-es` 未登记为服务
- **THEN** 产出候选 `homework-server → internal-bc-es` 并标记 `targetDeclared: false`

#### Scenario: 确认未登记目标时可同时登记服务
- **WHEN** 用户对未登记目标的候选选择"登记并确认"
- **THEN** 该服务出现在 `services` 中,依赖边落库,且体检 NOT 报出悬空引用

#### Scenario: 仅确认依赖会提示将产生悬空引用
- **WHEN** 用户对未登记目标的候选只确认依赖而不登记服务
- **THEN** 界面提示该边将成为悬空引用(由体检报出),而不是静默接受

### Requirement: 候选去重与自环排除
候选集合 SHALL 按 (from, to) 去重(合并证据与端点明细),SHALL 排除自环(from 与 to 相同)。

#### Scenario: 同一对服务的多条线索合并为一条候选
- **WHEN** 同一对服务既命中名称线索又命中多条路径线索
- **THEN** 输出一条候选,证据与端点明细为合集,置信度取较高档

#### Scenario: 自环被排除
- **WHEN** 线索指向调用方自身
- **THEN** 该候选不出现在结果中

### Requirement: 会导致环的候选单独标出
对会与既有依赖图构成环的候选,系统 SHALL 将其**单独标注**(而非静默丢弃),以便人判断这是架构问题还是误报。

#### Scenario: 成环候选被标记
- **WHEN** 既有图含 `A → B`,而推导出的候选为 `B → A`
- **THEN** 该候选以「将形成环」标记呈现,且默认不勾选确认

### Requirement: 候选只读产出于接口，不写库
推导 SHALL 只通过只读入口返回结果(含 `scannedAt` 时间戳),SHALL NOT 直接修改拓扑。确认落库 SHALL 是独立动作。

#### Scenario: 推导不产生副作用
- **WHEN** 调用推导入口
- **THEN** 拓扑文件未被修改,仅返回候选列表

### Requirement: 人工确认落库且不产生重复行
确认候选时系统 SHALL 复用既有的按服务对合并语义(来自 `service-dependency-graph`),使确认一个已存在
的服务对时**不新增重复行**,而是并入其明细。

#### Scenario: 确认候选后依赖更新且不重复
- **WHEN** 用户确认候选 `A → B`,而 `A → B` 已存在一条服务级边
- **THEN** 仍只有一条 `A → B` 边,新增的端点明细并入该边

#### Scenario: 批量确认
- **WHEN** 用户勾选多条候选并确认
- **THEN** 全部按同一合并语义落库,任意一对服务仍只占一行

### Requirement: 可复现的证据展示
每条候选 SHALL 在界面上展示其证据(命中文件/配置键/匹配端点)与置信度,使判断不依赖系统结论本身。

#### Scenario: 候选可被人工核验
- **WHEN** 用户在「推导候选」区块查看某条候选
- **THEN** 能看到置信度与至少一条具体证据(文件路径或配置键),据此决定确认或忽略
