# dependency-drift Specification

## Purpose
TBD - created by archiving change detect-declaration-drift. Update Purpose after archive.
## Requirements
### Requirement: 声明与代码证据的双向比对
系统 SHALL 对某个服务执行漂移核对:以该服务仓库内声明文件的边(`declared`)为一侧,以代码扫描出的
依赖候选为另一侧,产出三组结果:`consistent`(两侧都有)、`staleDeclared`(仅声明有)、
`undeclared`(仅代码有)。比对 SHALL 以 (from, to) 服务对为键,SHALL 以声明边为准判断"是否已声明"。

#### Scenario: 两侧一致
- **WHEN** 声明含 `homework-server → internal-homework`,代码中亦有对应的 Feign 调用证据
- **THEN** 该对出现在 `consistent`,不计入漂移

#### Scenario: 声明了但代码无证据
- **WHEN** 声明含 `homework-server → internal-legacy` 而代码中找不到任何调用证据
- **THEN** 该对出现在 `staleDeclared`,并附"扫描未找到证据,可能已删除或为动态构造的调用"的说明

#### Scenario: 代码有证据但未声明
- **WHEN** 代码中扫到 `homework-server → internal-qp` 的调用证据,而声明未提及该对
- **THEN** 该对出现在 `undeclared`,并携带置信度与证据

### Requirement: 置信度口径
漂移判定 SHALL 以**高置信(名称档)**候选为准绳;中置信(路径档)候选 SHALL 单列为
「可能未声明(中置信)」并 NOT 计入 `undeclared` 判定,以避免模板匹配的假阳性制造噪声。

#### Scenario: 中置信候选不进入判定
- **WHEN** 某对服务仅有路径档(中置信)证据、无名称档证据且未声明
- **THEN** 该对不出现在 `undeclared`,而出现在「可能未声明(中置信)」分列中

#### Scenario: 高置信候选进入判定
- **WHEN** 某对服务有名称档(高置信)证据且未声明
- **THEN** 该对出现在 `undeclared`

### Requirement: 静态扫描的局限必须如实声明
核对结果 SHALL NOT 把"未找到证据"表述为"依赖不存在"。`staleDeclared` 条目 SHALL 附带说明:
扫描为静态且启发式,动态拼接的 URL、配置驱动的路径等可能未被识别,故该项表示"需要人工确认"
而非"确认已失效"。

#### Scenario: 陈旧声明带保留措辞
- **WHEN** 某声明边被列入 `staleDeclared`
- **THEN** 该项显示的措辞为"未在代码中找到证据",并提示可能是扫描漏识别

### Requirement: 只读与非阻断
核对 SHALL 只读:NOT 修改声明文件、NOT 修改依赖图、NOT 自动新增或删除任何边。结果 SHALL 通过只读入口
返回,并在界面上与既有图级体检并列呈现为告警条(存在漂移时显示,无漂移时不显示)。

#### Scenario: 核对不产生副作用
- **WHEN** 执行一次漂移核对
- **THEN** 声明文件与拓扑文件均未被修改(字节不变)

#### Scenario: 无漂移时不显示告警
- **WHEN** 声明与代码证据完全一致
- **THEN** 界面不显示漂移告警条

### Requirement: 未声明文件的处理
当该服务仓库内没有声明文件时,核对 SHALL 明确说明"该服务未声明依赖,因此全部代码证据均为未声明",
并 SHALL NOT 把这种情况报成错误或空结果。

#### Scenario: 无声明文件的引导
- **WHEN** 某服务未放置声明文件而代码中存在依赖证据
- **THEN** 结果说明该服务尚无声明,列出全部代码证据为未声明,并引导写回一份声明作为基线

### Requirement: 未声明的引导处理
对 `undeclared` 条目,系统 SHALL 提供进入既有确认流程的引导(确认后可为该对落库并/或写入声明),
且 SHALL NOT 自动落库。

#### Scenario: 未声明条目可一键转入确认
- **WHEN** 用户对某 `undeclared` 条目选择处理
- **THEN** 进入既有的候选确认流程(可登记未登记目标、可确认依赖),而非在该界面直接写入

#### Scenario: 目标未登记时一并提示
- **WHEN** 某 `undeclared` 条目的目标服务未登记
- **THEN** 该条目同时标出"目标未登记",与既有候选呈现一致

