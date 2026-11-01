#!/usr/bin/env node
/**
 * 子包装载门禁（change `adopt-superagent-openspec-source`, task 11）。
 *
 * 在真实模块求值下断言 workmate-superagent-source 的装载契约：
 *   - 导出 name / inject / apply；
 *   - inject 恰为 ['orchestrator']，且**模块级**不含其它服务；
 *   - 用**没有 orchestrator** 的假 ctx 调用 apply：不抛错、不注册、不读写文件。
 *
 * 这三条对应 spec 的「作为独立 Source bundle 安装」与「装错 profile 只等待」。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.cwd()
const moduleUrl = pathToFileURL(join(root, 'packages', 'superagent-source', 'dist', 'source-watch.js')).href

const problems = []
const mod = await import(moduleUrl).catch((error) => {
  problems.push(`加载 dist/source-watch.js 失败：${error instanceof Error ? error.message : String(error)}`)
  return undefined
})

if (mod !== undefined) {
  if (typeof mod.name !== 'string' || mod.name !== 'workmate-superagent-source') {
    problems.push(`导出 name 不是 workmate-superagent-source（实际：${String(mod.name)}）`)
  }
  if (!Array.isArray(mod.inject) || mod.inject.length !== 1 || mod.inject[0] !== 'orchestrator') {
    problems.push(`导出 inject 应为 ['orchestrator']（实际：${JSON.stringify(mod.inject)}）`)
  }
  if (typeof mod.apply !== 'function') {
    problems.push(`导出 apply 不是函数（实际：${typeof mod.apply}）`)
  }

  // 没有 orchestrator 的假 ctx：只提供 effect 与 tools，apply 必须安静地什么都不做。
  let registered = 0
  const ctx = {
    effect: (fn) => {
      const result = fn()
      return typeof result === 'function' ? result : undefined
    },
    get: () => undefined,
    inject: (deps, callback) => {
      // 故意不满足任何依赖：模拟"装在没有 Super-agent 的 profile"。
      registered += 1
      return undefined
    },
  }
  try {
    const result = mod.apply(ctx, {})
    if (result !== undefined && typeof result !== 'function') {
      problems.push('apply 在没有 orchestrator 时返回了非函数值（应保持不活动）')
    }
  } catch (error) {
    problems.push(`apply 在没有 orchestrator 时抛错：${error instanceof Error ? error.message : String(error)}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[source-gate] ${problem}`)
  process.exit(1)
}
console.log('[source-gate] ok — name=workmate-superagent-source, inject=[orchestrator], apply 在无 orchestrator 时保持不活动')
