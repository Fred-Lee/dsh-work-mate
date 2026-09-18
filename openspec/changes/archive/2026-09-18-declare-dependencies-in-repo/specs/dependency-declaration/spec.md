## ADDED Requirements

### Requirement: 仓库内声明文件格式
系统 SHALL 识别仓库内的依赖声明文件 `.helmsman/dependencies.yml`(仓库根相对),格式 SHALL 为 YAML,含:
`version`(当前 `1`)、`service`(本服务在项目群中的 id)、`dependencies`(出站依赖列表,每项含必填 `to`,
可选 `method`、`endpoints`、`critical`)。文件 SHALL 只声明**出站**依赖。系统 SHALL NOT 要求文件中出现
入站依赖(谁调用我)。

#### Scenario: 最小声明即可表达依赖
- **WHEN** 文件仅含 `version: 1`、`service: homework-server` 与一条 `to: internal-homework`(无 method/endpoints)
- **THEN** 解析得到一条服务级依赖边 `homework-server → internal-homework`(`endpoints: []`、`method: '*'`)

#### Scenario: 带明细的声明
- **WHEN** 某条依赖含 `method: GET` 与 `endpoints: ['/qp/list']`
- **THEN** 该边带该明细,并作为同一对服务那条边的明细之一

#### Scenario: 缺少 service 标识时拒绝
- **WHEN** 文件缺少 `service` 字段
- **THEN** 解析失败并明确报出缺失字段,不产出任何边(边的 `from` 无从确定)

### Requirement: 作为导入源的抓取与人工核对
系统 SHALL 把声明文件作为**导入源**接入既有导入流程(source 名 `helmsman-declaration`),解析结果 SHALL 复用
现有 `ImportPreview` 形状(`services[]` 与 `dependencies[]`),使人工在既有「预览 → 勾选 → 应用」界面里
**核对**而非另行录入。应用 SHALL 走既有 `importApply` 的合并与成对去重语义。

#### Scenario: 抓取产出可核对的预览
- **WHEN** 对某仓库执行抓取
- **THEN** 得到一份预览:该服务 + 文件声明的各条依赖(含 `to` 与可选明细),等待人工确认后才落库

#### Scenario: 应用后不产生重复行
- **WHEN** 抓取的依赖中某一对服务在群里已存在
- **THEN** 应用后该对服务仍只有一条边(明细并入),行数不增加

### Requirement: 边的来源标记
`RestDependencyEdge` SHALL 支持可选 `source` 字段,取值 `'declared'`(来自仓库声明)或
`'derived'`(来自推导后人工确认)。缺省 SHALL 视为 `'declared'`(兼容既有数据)。归一化 SHALL 保留该字段。

#### Scenario: 来源在往返中保留
- **WHEN** 一份含 `source: 'derived'` 边的拓扑被保存后重新加载
- **THEN** 该边的 `source` 仍为 `'derived'`

#### Scenario: 存量数据按声明处理
- **WHEN** 加载一份没有 `source` 字段的既有拓扑
- **THEN** 其边按 `'declared'` 参与后续调和,不因缺少字段而被丢弃

### Requirement: 重新抓取的调和规则
重新抓取 SHALL 使 `declared` 边**与声明文件一致**:文件中新增的边被加入、文件中已移除的边被删除。
`derived` 边 SHALL NOT 被增删。因此对同一份未改动的声明重复抓取 SHALL 幂等(不改变依赖集合)。

#### Scenario: 文件删除一条依赖
- **WHEN** 文件中移除了 `homework-server → internal-ugc`,重新抓取并应用
- **THEN** 该 `declared` 边被移除,其余声明边与全部 `derived` 边保持不变

#### Scenario: 推导确认的边不被抓取冲掉
- **WHEN** 某 `derived` 边与声明文件无关,执行一次抓取
- **THEN** 该边仍在,不被新增或删除

#### Scenario: 重复抓取幂等
- **WHEN** 对未改动的声明文件连续抓取并应用两次
- **THEN** 第二次不改变依赖集合

### Requirement: 未登记目标可随抓取登记
声明引用的服务若未在项目群 `services` 中登记,系统 SHALL 在抓取结果中标出,并提供**登记该服务**的路径,
使应用后 NOT 产生悬空引用。

#### Scenario: 未登记目标提示可登记
- **WHEN** 声明引用 `internal-qp` 而该服务未登记
- **THEN** 预览中该项被标为"目标未登记",并可在同一流程中登记该服务

#### Scenario: 登记后无悬空引用
- **WHEN** 用户对未登记目标选择"登记并应用"
- **THEN** 该服务出现在 `services` 中,依赖边落库,体检 NOT 报出悬空引用

### Requirement: 回写声明文件
系统 SHALL 能把某个服务的当前 `declared` 依赖序列化为声明文件内容,供人工核对后写入仓库,
使声明文件可以是**生成物**而非手写物。

#### Scenario: 回写内容可被自身解析
- **WHEN** 对某服务回写并再次解析该输出
- **THEN** 解析结果与回写前的 `declared` 边集合一致(格式往返无损)

#### Scenario: 回写不包含推导边
- **WHEN** 某服务同时有 `declared` 与 `derived` 边
- **THEN** 回写内容只含 `declared` 边(推导边不应被固化为"仓库声明")

### Requirement: 文件缺失或损坏的处理
仓库缺少声明文件时,系统 SHALL 明确提示"该项目未声明依赖"并 NOT 视为错误;文件存在但解析失败时,
系统 SHALL 报出具体问题并 SHALL NOT 部分应用该文件的内容。

#### Scenario: 无文件不报错
- **WHEN** 对未放置声明文件的仓库执行抓取
- **THEN** 返回"未声明依赖"的明确结果,不抛错、不产生边

#### Scenario: 解析失败不做部分应用
- **WHEN** 声明文件某条依赖缺少必填 `to`
- **THEN** 抓取报出该问题,且不应用文件中的任何依赖边
