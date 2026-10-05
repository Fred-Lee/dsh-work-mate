# artifact-ledger Specification

## Purpose
TBD - created by archiving change add-artifact-ledger. Update Purpose after archive.
## Requirements
### Requirement: 声明集合与计划漂移

实现 SHALL 从 `tasks.md` 的 `<!-- writes: ... -->` 与 `design.md` 的 `<!-- files: ... -->`
收集声明文件范围，并由本提案的 `[proposal:<id>]` 标记提交计算实际改动文件集合
（`git diff --name-only <oldest>^..<newest>`），据此产出漂移：
`undeclared`（改了未声明）、`missing`（声明未改）、`driftRatio`。声明集合为空时
SHALL 返回"无法判定"而不是全部记作未声明。

#### Scenario: 未声明改动被列出

- **WHEN** 声明 `src/a/**` 而实际改了 `src/a/x.ts` 与 `src/b/y.ts`
- **THEN** 漂移的 `undeclared` 为 `['src/b/y.ts']`

#### Scenario: 无声明时不假报

- **WHEN** 工件里没有任何 writes/files 声明
- **THEN** 结果为"未声明范围，无法判定漂移"，`undeclared` 为空

### Requirement: 工件哈希账本

归档成功后，实现 SHALL 为归档目录里的工件记录 `{path, sha256, bytes, commit?}` 并写入
该项目的 manifest；路径 SHALL 为绝对路径或可定位的相对路径，哈希 SHALL 为文件内容的
sha256（读取失败时该条 SHALL 带 note 而 SHALL NOT 使整次归档失败）。

#### Scenario: 账本记录已知工件的哈希

- **WHEN** 归档目录含 `proposal.md`、`tasks.md`、`review.md`
- **THEN** manifest 的账本含这三条，每条有 sha256 与字节数

### Requirement: 可选漂移门

`Config.planDriftGate` 为 true 时，归档编排 SHALL 在存在未声明改动时失败并列出文件；
默认 false 时 SHALL 仅记录与展示，SHALL NOT 阻断；`force` SHALL 仍可跳过该门。

#### Scenario: 默认不拦

- **WHEN** 存在未声明改动且 `planDriftGate` 为 false
- **THEN** 归档成功，manifest 里能看到漂移

#### Scenario: 开启后拦截

- **WHEN** `planDriftGate` 为 true 且存在未声明改动
- **THEN** 编排失败且摘要列出未声明文件

