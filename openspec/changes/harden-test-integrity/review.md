# Review — 测试自证门禁

## 确认项

- **反证①：`include` 改窄必须红。** 把 `vitest.config.ts` 的 include 临时改成
  `src/features/quality/**/*.test.{ts,tsx}` 后运行 `node scripts/check-test-integrity.mjs`：
  - 改窄后 exit **1**，报出 40 个"声明在 include 内但本次没有执行"的文件；
  - 对照：本变更的**第一版**实现（用 include 展开全集）在同样改窄下报 **ok**
    （`3 个测试文件全部执行，25 条通过 … 磁盘 include 全集 3`）——即"自己给自己发绿灯"。
    这条对照是本设计 D2 改成"仓库独立发现全集"的直接原因。
  - 复原 `vitest.config.ts` 后 `git diff --stat vitest.config.ts` 为空（无残留改动）。
- **反证②：`it.skip` 必须红。** 临时加 `src/features/quality/__falsify.test.ts`，其中一条
  `it.skip`，`node scripts/check-test-integrity.mjs` exit **1**，输出
  `有 1 条用例被 skip/pending —— 静默摘除不算通过`；同一次运行 `pnpm test` 是 exit 0。
  探针文件已删除（`ls` 确认不存在）。
- **反证③：正常状态必须绿。** 复原后 exit 0：
  `[test-integrity] ok — 43 个测试文件全部执行，377 条通过，0 skip / 0 todo`。
- **门禁自身有用例**：`scripts/check-test-integrity.test.mjs` 7 条（四类假绿 + 解析 + 归一化），
  随 `pnpm test:toolchain` 跑：35 条全绿（原 28 条 + 新增 7 条）。
- **`verify` 已含测试**：`package.json` 的 `verify` 末尾追加 `pnpm verify:test`。

## 疑问项

- 门禁跑完整测试集，`pnpm verify` 因此从秒级变成约 15 秒。取舍：纪律文档要求归档前跑
  `pnpm verify`，而它此前不含测试 —— 慢一点比"门禁全绿但其实没跑测试"划算。
- `scripts/*.test.mjs` 归 `node --test`，不在本门禁范围。是否合并成一条统一入口，
  留给后续提案（本变更不扩大范围）。

## 建议补充项

- 若将来真需要长期排除某个测试文件（例如必须联网），约定改为显式改名或
  `describe.skip` —— 那时门禁会红，逼出一次显式决定，而不是让它静默消失。

## CRITICAL 问题

无。

## 明确没验什么

- **没验**：用例本身有效（`expect(true).toBe(true)` 一样通过）。本门禁管"跑没跑"，
  不管"测得对不对"，这一点写进了脚本注释、README 8.1 与 AGENTS.md。
- **没验**：真机装载（归 `pnpm verify:client` 与人工重启验收；本会话按要求不重启 harness）。
- **没验**：`--changed` / watch 模式下的行为。

## 审查者与独立性（诚实声明）

本文件由**写代码的同一个 agent** 在实现过程中写成 —— 用新加的 `reviewerIndependence`
判据衡量，这是 `same-as-author`（自评），不是独立审查。独立审查记录见下一节。

<!-- reviewer: harden-test-integrity-author -->

## 独立审查

（见文末"独立审查结论"一节；由独立 subagent 会话产出，与实现者不同上下文。）

