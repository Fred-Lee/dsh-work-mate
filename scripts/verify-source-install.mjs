#!/usr/bin/env node
/**
 * 子包安装自检（change `adopt-superagent-openspec-source`, task 25）。
 *
 * 为什么不能只靠单测：子包能否被 Super-agent 的 profile **自动启用**，取决于三件
 * 安装期事实——包在不在 node_modules、包名在不在 `dsh.profile.bundles`、bundle 的
 * patch 能不能被解析成唯一一条 entry。任何一条不成立，进程照常启动，只是这个来源
 * 永远不出现，症状是"面板一直显示执行器离线/待扫描"。
 *
 * 断言四条：
 *   ① `<profile>/node_modules/workmate-superagent-source` 存在且版本可读；
 *   ② profile 的 `dsh.profile.bundles` 含包名；
 *   ③ 该包 `dsh.bundle.patch` 指向的文件恰好只有一条 entry；
 *   ④ 用宿主的 `--dump-config-schema` 确认该插件条目 `status: schema`
 *      （没有 schema 说明运行时导出缺失，装上了也不会被校验/渲染）。
 *
 * 用法：
 *   node scripts/verify-source-install.mjs --profile ~/.dsh/profiles/superagent
 *   node scripts/verify-source-install.mjs --profile <dir> --dsh <path-to-bin.js>
 *
 * 退出码：0 通过（允许 ④ 因找不到宿主而 skip）；1 有断言失败；2 参数错误。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const PACKAGE = 'workmate-superagent-source'
const PLUGIN_NAME = 'workmate-superagent-source'

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

/**
 * 数 bundle patch 的 entry 条数。只认 `- id:` 行：patch 里每个插件条目必有 id，
 * 而其它字段（name/config/insert）不会长成这个形状。宁可多数也不能少数——
 * 这里的目标是"恰好一条"，多一条同样要报。
 */
export function countPatchEntries(text) {
  return text.split('\n').filter((line) => /^\s*-\s+id:\s*\S/.test(line)).length
}

/** 去掉 YAML 注释行后再数，避免注释里的示例被算进去。 */
export function countPatchEntriesOfFile(text) {
  const body = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  return countPatchEntries(body)
}

/** 一条断言的形状：`skipped` 不算失败，但必须在报告里可见。 */
const check = (name, fn) => ({ name, fn })

export function checksFor(options) {
  return [
    check('包已安装且版本可读', async () => {
      const dir = join(options.profileDir, 'node_modules', PACKAGE)
      if (!existsSync(dir)) {
        return { ok: false, detail: `未安装：${dir} 不存在（用 dsh plugin --profile <p> add <子包目录> 安装）` }
      }
      const manifest = await readJson(join(dir, 'package.json')).catch(() => undefined)
      if (manifest === undefined || typeof manifest.version !== 'string') {
        return { ok: false, detail: `${dir}/package.json 不可读或没有 version` }
      }
      return { ok: true, detail: `${manifest.name}@${manifest.version}` }
    }),

    check('bundle 已加入 dsh.profile.bundles', async () => {
      const manifest = await readJson(join(options.profileDir, 'package.json')).catch(() => undefined)
      if (manifest === undefined) return { ok: false, detail: `${options.profileDir}/package.json 不存在或不可读` }
      const bundles = manifest.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) {
        return { ok: false, detail: 'profile package.json 没有 dsh.profile.bundles 数组' }
      }
      const found = bundles.includes(PACKAGE)
      return found
        ? { ok: true, detail: `bundles 含 ${PACKAGE}` }
        : { ok: false, detail: `bundles 不含 ${PACKAGE}：${bundles.join('、') || '（空）'}` }
    }),

    check('bundle patch 恰好一条 entry', async () => {
      const dir = join(options.profileDir, 'node_modules', PACKAGE)
      const manifest = await readJson(join(dir, 'package.json')).catch(() => undefined)
      const patchRelative = manifest?.dsh?.bundle?.patch
      if (typeof patchRelative !== 'string' || patchRelative === '') {
        return { ok: false, detail: 'package.json 未声明 dsh.bundle.patch —— 宿主不会自动启用这个包' }
      }
      const patchFile = resolve(dir, patchRelative)
      const text = await readFile(patchFile, 'utf8').catch(() => undefined)
      if (text === undefined) return { ok: false, detail: `patch 文件不可读：${patchFile}` }
      const count = countPatchEntriesOfFile(text)
      return count === 1
        ? { ok: true, detail: `${patchRelative} 有 1 条 entry` }
        : { ok: false, detail: `${patchRelative} 有 ${count} 条 entry（应恰好 1 条）` }
    }),

    check('来源出现在 --dump-config-schema 且可装载', async () => {
      // `dsh: null` 是显式的"别跑宿主"（测试与离线核对用），与"没指定"不同。
      const dsh = options.dsh === null ? undefined : options.dsh ?? findDsh()
      if (dsh === undefined) {
        return { ok: true, skipped: true, detail: '未找到宿主 CLI（用 --dsh 指定），跳过运行时校验' }
      }
      // 宿主的 profile 可能有与本来源无关的告警/错误（so 退出码非 0），但 JSON 仍可能
      // 正常输出；顺序是"先看 stdout，再按退出码决定是否判失败"。
      const outcome = await run(process.execPath, [dsh, '--profile', options.profileName, '--dump-config-schema'], {
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      }).then(
        (result) => ({ stdout: result.stdout, failed: false, stderr: '' }),
        (error) => ({
          stdout: typeof error.stdout === 'string' ? error.stdout : '',
          failed: true,
          stderr: typeof error.stderr === 'string' ? error.stderr : String(error),
        }),
      )
      let entries
      try {
        entries = collectEntries(JSON.parse(outcome.stdout))
      } catch {
        return {
          ok: true,
          skipped: true,
          detail: `宿主 --dump-config-schema 未给出可解析的 JSON（退出码 ${outcome.failed ? '非 0' : '0'}），本次跳过运行时校验`,
          ...(outcome.failed ? { note: outcome.stderr.split('\n').slice(0, 4).join(' / ') } : {}),
        }
      }
      const entry = entries.find((value) => value.name === PLUGIN_NAME)
      if (entry === undefined) {
        return { ok: false, detail: `--dump-config-schema 里没有 ${PLUGIN_NAME}（先确认已装且已进 bundles）` }
      }
      // 宿主对每个条目的 status 语义（`config-schema/collect.ts:192-214`）：
      //   schema     = 模块被成功 import 且导出原生 Schemastery Config
      //   absent     = 模块被成功 import，但没有 profile 级 Config —— **本来源的预期值**：
      //                它没有任何插件级配置，全部配置属于 Source 实例（存 Super-agent 自己的库）
      //   unsupported/error = 导出了非原生 Config / 装载抛错 —— 这两种才是真故障
      if (entry.status === 'error' || entry.status === 'unsupported') {
        return { ok: false, detail: `条目 ${String(entry.id)} status=${String(entry.status)}（模块装载失败或 Config 不是原生 Schemastery）` }
      }
      return {
        ok: true,
        detail: `条目 ${String(entry.id)} status=${String(entry.status)}${entry.status === 'absent' ? '（预期：无插件级 Config，配置属于 Source 实例）' : ''}`,
      }
    }),
  ]
}

/** `--dump-config-schema` 把条目列表放在 `$comment` 之外的某个键里；递归找带 name+status 的对象。 */
export function collectEntries(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEntries(item, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.name === 'string' && typeof value.status === 'string' && typeof value.path === 'string') {
      found.push(value)
    }
    for (const item of Object.values(value)) collectEntries(item, found)
  }
  return found
}

/** 按优先级找宿主 CLI：`$DSH_BIN` → 本机 workspace → PATH 里的 dsh。 */
export function findDsh(env = process.env) {
  const candidates = [env['DSH_BIN'], '/Users/fredlee/Documents/workspace/deepseek-harness/apps/cli/lib/bin.js']
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profileDir = argv[++index]
    else if (arg === '--name') options.profileName = argv[++index]
    else if (arg === '--dsh') {
      const value = argv[++index]
      // `--dsh none` 显式关掉运行时校验（离线环境/纯静态核对）。
      options.dsh = value === 'none' ? null : value
    }
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

/** 主流程：逐条执行，返回报告（CLI 与测试共用）。 */
export async function verifyInstall(options) {
  const profileDir = resolve(options.profileDir ?? '')
  const checks = checksFor({
    profileDir,
    profileName: options.profileName ?? profileDir.split('/').filter(Boolean).pop() ?? '',
    ...('dsh' in options ? { dsh: options.dsh } : {}),
  })
  const results = []
  for (const entry of checks) {
    try {
      const result = await entry.fn()
      results.push({ name: entry.name, ...result })
    } catch (error) {
      results.push({ name: entry.name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    profileDir,
    ok: results.every((result) => result.ok === true),
    results,
  }
}

export function formatReport(report) {
  const lines = [`Super-agent 来源安装自检：${report.profileDir}`, '']
  for (const result of report.results) {
    const mark = result.ok === true ? (result.skipped === true ? 'skip' : ' ok ') : 'FAIL'
    lines.push(`[${mark}] ${result.name}`)
    if (result.detail !== undefined) lines.push(`       ${result.detail}`)
  }
  lines.push('', report.ok ? '结论：来源可被宿主装载。' : '结论：上面 FAIL 的项不修好，这个来源不会工作。')
  return lines.join('\n')
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help === true || options.profileDir === undefined) {
      process.stdout.write(
        '用法：node scripts/verify-source-install.mjs --profile <superagent profile 目录> [--name <profile 名>] [--dsh <宿主 bin.js>] [--json]\n',
      )
      process.exit(options.help === true ? 0 : 2)
    }
    const report = await verifyInstall(options)
    process.stdout.write(options.json === true ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n')
    process.exit(report.ok ? 0 : 1)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
}
