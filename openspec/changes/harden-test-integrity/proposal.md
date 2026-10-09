# 测试自证门禁：拒绝"退出码 0 式"假绿

## Why

来源：与 `harden-archive-gates` 同一次调研（dsh-graph 的 `scripts/run-tests.mjs` 做三路
交叉核对），以及本次开发中的**实测复现**。

`pnpm test` 的退出码 0 只说明"vitest 跑完没崩"。以下假绿它盖不住，本次开发中都实测到了：

1. **`include` 被改窄**。把 `vitest.config.ts` 改成只跑 `src/features/quality/**` 后：
   vitest exit 0、人类输出 `3 files / 25 tests` 全绿，而磁盘上有 43 个测试文件 ——
   **40 个文件静默不跑，没有任何信号**。这是最常见的假绿形态（本地临时收窄忘改回）。
2. **`it.skip` 静默摘除**。加一条 `it.skip` 后 vitest 仍 exit 0，输出里只有一行小字。
3. **执行文件集与磁盘文件集不一致**（早退 / worker 死亡）没有任何断言。
4. **`pnpm verify` 不包含测试**。现有四道门是契约 / 工具链 / 宿主兼容 / 客户端工厂 ——
   门禁全绿 ≠ 测试全绿，但纪律文档常把两者混着说。

对照 dsh-graph：它的测试脚本拒绝"自报成功"，用自报 / 产物 / 汇总三方交叉核对。这是它
最值得抄的一条纪律，而 WorkMate 恰好缺。

## 来源 / Provenance

- source: `review-finding`
- sourceRef: `https://github.com/miuzel/dsh-graph/blob/main/scripts/run-tests.mjs`

### intent 形状

- **Problem**：测试是否"全部真的跑了"没有任何机器判据；门禁集合里也没有测试。
- **Proposed outcome**：新增第五道门 `pnpm verify:test`，用 vitest 的 JSON reporter 拿机器可读
  事实，与**仓库独立发现**的测试文件全集交叉核对，任一条对不上即 exit 1。
- **Affected users and systems**：`pnpm verify` 的调用者（多一道门、更慢）；改 `include`、
  写 `.skip` 的人会立刻收到红字；`pnpm test` 语义不变（开发者仍可单跑）。
- **Constraints**：不新增运行时/开发依赖；不改 `pnpm test`；不复用 `include` 作为"全集"来源
  （否则改窄 include 就等于自己给自己发绿灯）；脚本自身要能自测（`pnpm test:toolchain`）。
- **Open questions**：`scripts/*.test.mjs` 归 `node --test`（`pnpm test:toolchain`），
  本门禁**不覆盖**它们——是否要合并到一条统一入口，留给后续提案。

## What Changes

- **`scripts/check-test-integrity.mjs`**：跑一次 vitest（JSON reporter），然后
  ① 用仓库级规则 `**/*.test.{ts,tsx}`（排除 `node_modules`/`dist`/`.git`/`.workmates`/`.worktrees`/`coverage`）
  独立发现全集；② 断言"全集 ⊆ 已执行"且"已执行 ⊆ 全集"；③ 断言 `pending`/`todo`/`failed` 均为 0
  且 `passed > 0`；④ 断言 `include` 仍在配置里显式声明（否则先修配置）。
- **`scripts/check-test-integrity.test.mjs`**：对纯函数 `evaluateIntegrity` / `parseInclude` /
  `executedFiles` 的用例（假绿四类各一条），随 `pnpm test:toolchain` 跑。
- **`package.json`**：新增 `verify:test`，并把它并入 `pnpm verify`（第五道门）。
- **文档**：`AGENTS.md` 的常用命令与验证纪律、`README.md` 的验证章节写明这道门**证明什么、
  不证明什么**（不证明用例有效）。

## Impact

- 影响文件：`scripts/check-test-integrity.mjs`、`scripts/check-test-integrity.test.mjs`、
  `package.json`、`AGENTS.md`、`README.md`。
- 规格：新增 capability `test-integrity`（见 `specs/`）。
- 兼容性：`pnpm verify` 变慢（多跑一遍完整测试，约 15s），并且从此"include 改窄 / 有 skip"
  会拦门禁——这是本次变更的目的。
- 范围外（明确不做）：不做用例有效性判定（机器无法证明 `expect` 有意义）；
  不接管 `--changed` / watch 模式；不合并 `node --test` 那条线。
