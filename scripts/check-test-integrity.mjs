/**
 * 测试自证门禁（change `harden-test-integrity`）。
 *
 * 为什么需要它：`vitest run` 的退出码 0 只说明"它跑完没崩"。以下几种假绿它盖不住 ——
 *  1. `include` 规则被改窄（例如把某个目录移出 `src/`），文件静默不跑；
 *  2. 用例被 `it.skip` / `describe.skip` / `test.todo` 悄悄摘掉，汇总里只体现为
 *     pending 计数（很多人只看 passed）；
 *  3. 收集到的文件数与真正执行的数不一致（早退 / 部分 worker 死掉）；
 *  4. 有人把 `pnpm test` 换成只跑子集却仍当"全绿"。
 *
 * 做法：用 vitest 的 JSON reporter 拿**机器可读**事实（不解析人类输出，也不看退出码），
 * 再与**仓库范围内独立发现的**测试文件全集交叉核对。全集刻意不复用 `vitest.config.ts`
 * 的 `include`：若复用，把 include 改窄就等于自己给自己发绿灯（这恰恰是要拦的第 1 类假绿）。
 * 因此本门禁的规则是"仓库里每个 `*.test.ts(x)` 都必须被 vitest 执行"。
 *
 * 已知边界（诚实声明）：它证明"每个该跑的测试文件都被执行且没有静默跳过"，**不证明**用例
 * 本身有效（`expect(true).toBe(true)` 也能通过），也不覆盖 `--changed` / watch 模式。
 * `scripts/*.test.mjs` 走 `node --test`（`pnpm test:toolchain`），不在本门禁范围。
 */
import { readFileSync, existsSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { join } from 'node:path'

/** 从 vitest.config.ts 文本里取出 include 规则（要求显式声明；仅作健全性检查）。 */
export function parseInclude(configText) {
  const match = configText.match(/include:\s*\[([^\]]+)\]/s)
  if (match === null) return []
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((entry) => entry[1] ?? entry[2])
}

/**
 * 纯判定：把"磁盘全集 / 实际执行 / 汇总计数"三份事实交叉核对。
 * @returns 逐条问题（空数组 = 通过）。
 */
export function evaluateIntegrity({ onDisk, executed, counts }) {
  const problems = []
  const executedSet = new Set(executed)
  const diskSet = new Set(onDisk)

  for (const file of diskSet) {
    if (!executedSet.has(file)) problems.push(`声明在 include 内但本次没有执行：${file}`)
  }
  for (const file of executedSet) {
    if (!diskSet.has(file)) problems.push(`执行了 include 之外的文件：${file}`)
  }

  const passed = counts.passed ?? 0
  if ((counts.pending ?? 0) > 0) problems.push(`有 ${counts.pending} 条用例被 skip/pending —— 静默摘除不算通过`)
  if ((counts.todo ?? 0) > 0) problems.push(`有 ${counts.todo} 条用例是 todo —— 未实现不算通过`)
  if ((counts.failed ?? 0) > 0) problems.push(`有 ${counts.failed} 条用例失败`)
  if (passed === 0) problems.push('通过的用例数为 0')
  if (onDisk.length === 0) problems.push('include 展开后没有任何测试文件 —— 规则可能被改坏了')
  if ((counts.totalSuites ?? 0) > 0 && (counts.passedSuites ?? 0) === 0) {
    problems.push('没有任何测试套件通过')
  }
  return problems
}

/**
 * 仓库范围内独立发现 vitest 应执行的测试文件。
 *
 * **不复用 vitest.config.ts 的 include**：复用的话，"把 include 改窄"就会自己给自己
 * 发绿灯。这里用固定的仓库级规则：任意目录下的 `*.test.ts` / `*.test.tsx`，
 * 排除 `node_modules`、`dist`、`.worktrees`/`.workmates`、`.git`。
 * `*.test.mjs` 归 `node --test`（`pnpm test:toolchain`），不在此列。
 */
export async function discoverTestFiles(root) {
  const skip = /(^|\/)(node_modules|dist|\.git|\.workmates|\.worktrees|coverage)(\/|$)/
  const found = new Set()
  for await (const entry of glob('**/*.test.{ts,tsx}', { cwd: root })) {
    if (!skip.test(entry)) found.add(entry)
  }
  return [...found].sort()
}

/** 顶层 testResults[] 的文件名集合（vitest 3 的 JSON 形状）。 */
export function executedFiles(report, root) {
  const names = new Set()
  for (const entry of report.testResults ?? []) {
    if (typeof entry.name === 'string') names.add(entry.name.replace(`${root}/`, ''))
  }
  return [...names]
}

async function main() {
  const root = process.cwd()
  const configPath = join(root, 'vitest.config.ts')
  if (!existsSync(configPath)) {
    console.error('[test-integrity] 找不到 vitest.config.ts —— 无法核对 include 规则')
    process.exit(1)
  }
  const include = parseInclude(readFileSync(configPath, 'utf8'))
  if (include.length === 0) {
    console.error('[test-integrity] vitest.config.ts 未显式声明 include —— 先修配置，本门禁不接受隐式全集')
    process.exit(1)
  }

  // 全集由仓库独立发现，不由 include 决定（见 discoverTestFiles 的说明）。
  const onDisk = await discoverTestFiles(root)

  const { execFileSync } = await import('node:child_process')
  const bin = join(root, 'node_modules', 'vitest', 'vitest.mjs')
  const outputFile = join(root, 'node_modules', '.vitest-integrity.json')
  try {
    execFileSync(process.execPath, [bin, 'run', '--reporter=json', '--outputFile', outputFile], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    console.error(
      `[test-integrity] vitest 退出非零（有用例失败或环境错误）：${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    )
    process.exit(1)
  }
  if (!existsSync(outputFile)) {
    console.error('[test-integrity] vitest 未产出 JSON 报告 —— 无法核对执行事实')
    process.exit(1)
  }
  const report = JSON.parse(readFileSync(outputFile, 'utf8'))
  const problems = evaluateIntegrity({
    onDisk,
    executed: executedFiles(report, root),
    counts: {
      passed: report.numPassedTests ?? 0,
      failed: report.numFailedTests ?? 0,
      pending: report.numPendingTests ?? 0,
      todo: report.numTodoTests ?? 0,
      totalSuites: report.numTotalTestSuites ?? 0,
      passedSuites: report.numPassedTestSuites ?? 0,
    },
  })

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[test-integrity] ${problem}`)
    console.error(
      `[test-integrity] 磁盘文件 ${onDisk.length} / 执行文件 ${executedFiles(report, root).length} / 通过用例 ${
        report.numPassedTests ?? 0
      }`,
    )
    process.exit(1)
  }
  console.log(
    `[test-integrity] ok — ${executedFiles(report, root).length} 个测试文件全部执行，${
      report.numPassedTests ?? 0
    } 条通过，0 skip / 0 todo（仓库发现全集 ${onDisk.length}，与 include 无关）`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
