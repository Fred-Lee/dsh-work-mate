# Design — 测试自证门禁

<!-- files: scripts/check-test-integrity.mjs, scripts/check-test-integrity.test.mjs, package.json, AGENTS.md, README.md -->

## D1 事实来源：JSON reporter，不解析人类输出

`vitest run --reporter=json --outputFile <path>` 给出结构化事实：顶层 `testResults[]`
每个条目就是一个测试文件（`name` 是绝对路径、`status` 是 §文件级§结果），
外加 `numPassedTests` / `numFailedTests` / `numPendingTests` / `numTodoTests` /
`numTotalTestSuites` / `numPassedTestSuites`。

不选"解析终端输出"（格式随版本变、颜色码、截断）也不选"看退出码"（这正是要被取代的判据）。
输出文件落在 `node_modules/.vitest-integrity.json`——已在 `.gitignore` 的 `node_modules/` 内，
不污染工作区。

## D2 "全集"必须独立发现，不能复用 `include`

这是本设计最关键的一条，来自**实测教训**：第一版实现用 `vitest.config.ts` 的 `include`
展开磁盘全集，结果把 include 改窄（`src/features/quality/**`）后脚本**报绿**——
`3 files / 25 tests` 与"磁盘全集 3"完全自洽。它只验证了"include 内的一致"，而
"把测试移出 include"正是要拦的头号假绿。**用自己的判据做全集，等于自己给自己发绿灯。**

改用仓库级固定规则：`**/*.test.{ts,tsx}`，排除 `node_modules`/`dist`/`.git`/`.workmates`/
`.worktrees`/`coverage`。`include` 仍然读取，但只用于"配置是否还显式声明"的健全性检查。

**替代方案与取舍**：不采用"在 vitest 里写自定义 reporter 插件"——那要改 `vitest.config.ts`
并把门禁逻辑塞进测试运行进程（测试挂了它也跟着挂，且门禁自身无法被单测）。脚本 + 纯函数
可以被 `node --test` 直接覆盖（D4）。

## D3 判据：四条，全部是"能确证"的假绿

| # | 判据 | 拦住的假绿 |
| --- | --- | --- |
| 1 | 全集 ⊆ 已执行 | include 改窄、部分 worker 静默死亡 |
| 2 | 已执行 ⊆ 全集 | 跑了 include 之外的东西（配置漂移、符号链接） |
| 3 | `pending == 0 && todo == 0 && failed == 0 && passed > 0` | `it.skip` / `test.todo` / 全红 / 空跑 |
| 4 | include 在配置里显式声明 | 配置被改成隐式全集（无法核对执行范围） |

第 3 条里 `pending` 对应 vitest 的 skip 与"被筛选掉"两类；`todo` 单列（未实现 ≠ 通过）。
两者分开报，便于定位。

## D4 门禁自身要能被测：纯函数 + 薄主流程

`evaluateIntegrity({onDisk, executed, counts})` 是纯函数，返回问题清单；
`parseInclude` / `executedFiles` 也是纯的。主流程只在 `import.meta.url === file://argv[1]`
时执行（被 import 时不跑测试）。这样 `scripts/check-test-integrity.test.mjs` 能对四类假绿
各写一条用例，随 `pnpm test:toolchain` 跑——门禁脚本自己没有被测试，是上一代门禁的通病
（`check-*.mjs` 有测试，`bands-watch.mjs` 也有，这条线保持一致）。

## D5 并入 `pnpm verify`，但不改 `pnpm test`

```json
"verify:test": "node scripts/check-test-integrity.mjs",
"verify": "pnpm verify:contract && pnpm verify:toolchain && pnpm verify:host-compat && pnpm verify:client && pnpm verify:test"
```

- 并入 `verify`：纪律文档说"归档前跑 `pnpm verify`"，而 `verify` 此前不含测试——
  这是"门禁全绿"和"测试全绿"两件事被混为一谈的根源。
- 不改 `pnpm test`：开发者单跑测试不该被门禁的额外要求（不许 skip）绑架；
  但门禁会跑完整测试集，所以 `pnpm verify` 现在真正覆盖两边。
- 把它放在最后：前面四道门是秒级的，先失败先报，省一次 15 秒的测试运行。

## 已知边界（写进脚本注释与文档，不掩饰）

- 不证明用例有效：`expect(true).toBe(true)` 一样通过。本门禁管"跑没跑"，不管"测得对不对"。
- 不覆盖 `--changed` / watch。
- 不覆盖 `scripts/*.test.mjs`（`node --test`，归 `pnpm test:toolchain`）。
- 不覆盖真机装载（归 `pnpm verify:client` 与人工重启验收）。

## 风险与回滚

- 风险：某个历史文件长期被有意排除（例如会真的调外部服务）。缓解：那应显式改名为
  `*.manual-test.ts` 或在文件内 `describe.skip`——**并且**那时门禁会红，逼出一次显式决定，
  这正是期望行为。
- 回滚：从 `verify` 里摘掉 `verify:test` 一个词即可；脚本与用例可保留。
