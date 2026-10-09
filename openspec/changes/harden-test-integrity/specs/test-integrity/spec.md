# test-integrity Specification

## Purpose

`pnpm test` 的退出码只说明"跑完没崩"。本 capability 规定第五道门禁 `pnpm verify:test` 的
判据：每个应跑的测试文件都必须真的被执行，且不允许静默跳过；"全集"必须由仓库独立发现，
不得复用 `vitest.config.ts` 的 `include`（复用会让"改窄 include"自己给自己发绿灯）。

## Requirements

### Requirement: 测试文件全集独立于 include

门禁 SHALL 用仓库级规则（`**/*.test.{ts,tsx}`，排除 `node_modules` / `dist` / `.git` /
`.workmates` / `.worktrees` / `coverage`）发现测试文件全集，SHALL NOT 以
`vitest.config.ts` 的 `include` 展开结果作为全集。配置里 `include` 未显式声明时，
门禁 SHALL 失败并提示先修配置。

#### Scenario: include 被改窄

- **WHEN** `include` 被改成只匹配 `src/features/quality/**` 而磁盘上还有其他测试文件
- **THEN** 门禁列出**每一个**未被执行的声明外文件并以非零码退出（不得因"include 内自洽"而通过）

### Requirement: 执行集与全集双向一致

门禁 SHALL 断言"全集 ⊆ 已执行"与"已执行 ⊆ 全集"；任一方向不满足 SHALL 逐条列出文件名并失败。

#### Scenario: 部分文件没有执行

- **WHEN** 磁盘上有 43 个测试文件而 vitest 只报告 3 个
- **THEN** 门禁报出其余 40 个文件"声明内但未执行"并以非零码退出

### Requirement: 不允许静默跳过

门禁 SHALL 断言 `pending` 与 `todo` 均为 0、`failed` 为 0、`passed` 大于 0；
任一条不满足 SHALL 失败，并在输出中给出计数。

#### Scenario: 一条 it.skip

- **WHEN** 测试集中存在一条 `it.skip`
- **THEN** 门禁报出 pending 计数并以非零码退出

#### Scenario: 空跑

- **WHEN** 展开后没有任何测试文件（规则被改坏）
- **THEN** 门禁报"没有任何测试文件"与"通过用例数为 0"

### Requirement: 门禁自身可被测试且并入 verify

门禁的判定逻辑 SHALL 以纯函数暴露（全集 / 执行集 / 汇总计数 → 问题清单），
主流程仅在被直接执行时运行；门禁 SHALL 自带用例并随 `pnpm test:toolchain` 执行。
`pnpm verify` SHALL 包含该门禁，且 SHALL NOT 改变 `pnpm test` 的语义。

#### Scenario: 门禁用例覆盖四类假绿

- **WHEN** 运行 `pnpm test:toolchain`
- **THEN** 存在分别针对"文件未执行 / 执行了全集之外 / skip 与 todo / 空跑与全红"的用例

#### Scenario: verify 含测试

- **WHEN** 运行 `pnpm verify`
- **THEN** 契约 / 工具链 / 宿主兼容 / 客户端工厂之后跑测试自证门禁，测试自证失败则 `verify` 失败
