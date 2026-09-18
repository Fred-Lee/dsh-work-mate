# derivation-scope Specification

## Purpose
TBD - created by archiving change config-first-derivation. Update Purpose after archive.
## Requirements
### Requirement: 推导的扫描范围选项
依赖推导 SHALL 支持范围选项 `scope`,取值 `'config'`(默认)或 `'full'`。`config` 范围 SHALL 只读取
配置类文件(`.yml` / `.yaml` / `.properties` / `.env` / `.conf`),SHALL NOT 读取 Java/TS 等源码文件;
`full` 范围 SHALL 保持现行为(配置 + 代码)。`config` 范围 SHALL 沿用既有配置解析与资源上限
(数量/大小/containment),SHALL NOT 发起网络请求。

#### Scenario: config 范围只读配置文件
- **WHEN** 对一个含 Java 源码与 YAML 配置的仓库以 `scope: 'config'` 推导
- **THEN** 扫描过程不读取任何 `.java`/`.ts` 文件,仅从配置文件产出候选

#### Scenario: config 范围足以覆盖本仓形态
- **WHEN** 仓库的 `application-*.yml` 在 `feign-client-config.<svc>.url` 登记了各 Feign 目标
- **THEN** `config` 范围即为每个目标产出名称档(高置信)候选,无需读取 Java 文件

#### Scenario: full 范围保持既有能力
- **WHEN** 以 `scope: 'full'` 推导
- **THEN** 结果与现行行为一致(含来自代码的端点明细候选)

### Requirement: 结果标注来源与范围
推导结果 SHALL 标注本次使用的 `scope`,并 SHALL 使每条候选的来源可辨识(配置线索或代码线索),
使"候选来自配置还是代码"可核查。

#### Scenario: 结果携带范围标注
- **WHEN** 以任一 scope 完成推导
- **THEN** 结果含 `scope` 字段,且各候选的证据能区分其来源类别

### Requirement: 无证据仍走人工确认
无论范围如何,系统 SHALL 维持"无证据不产出候选"的不变式;配置与代码都查不到依据的目标 SHALL NOT
被凭空生成,相关服务间的依赖 SHALL 由人工确认或声明(既有路径)负责。

#### Scenario: 配置中无依据不猜
- **WHEN** 某服务的配置文件不含任何指向其他服务的线索,且 scope 为 `config`
- **THEN** 不为它产出任何候选(而不是猜测);需要时由人工经既有确认/声明路径补充

### Requirement: 默认快扫与显式深扫
界面与漂移核对 SHALL 默认使用 `config` 范围;`full` SHALL 作为显式动作(如「深度扫描(含代码)」)
提供,且 SHALL 说明其代价与增益(更慢、可产出端点明细)。

#### Scenario: 默认走快扫
- **WHEN** 用户在界面上点「推导候选」而未选择深扫
- **THEN** 本次推导以 `config` 范围执行并在结果中标注

#### Scenario: 深扫为显式选择
- **WHEN** 用户勾选「深度扫描(含代码)」后再推导
- **THEN** 本次推导以 `full` 范围执行,结果可包含来自代码的端点明细

### Requirement: 漂移措辞随范围如实调整
当核对使用 `config` 范围时,"证据未找到"的说明 SHALL 指明扫描范围为配置文件(如"未在配置与(如启用)
代码扫描范围内找到证据"),SHALL NOT 表述为"依赖不存在";范围对漂移结论的减弱 SHALL 被如实标注。

#### Scenario: 快扫下的陈旧声明措辞
- **WHEN** 以 `config` 范围核对,某声明边在配置中无线索
- **THEN** 该项措辞为"未在配置扫描范围内找到证据",并保留"需人工确认"的引导

