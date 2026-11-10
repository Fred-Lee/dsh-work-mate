/**
 * 回滚 Super-agent 模式留下的 worktree、分支与端口（change
 * `adopt-superagent-openspec-source`, task 22）。
 *
 * 为什么单独一个脚本而不是走面板：回滚要能在**执行器已经不存在**时跑
 * （profile 删了、包卸了、端点不可达），所以它只读 WorkMate 自己的落盘文件
 * （`tasks.json` / `ports.json` / `projects.json`），不碰 Super-agent 的管理 API。
 *
 * 目录定位分三级，取第一个可用来源：
 *   ① 任务记录缓存（`directory`）—— 面板观察到 Ticket 时回写的；
 *   ② 命名推导 —— Super-agent 的目录是 `<执行根>/<短名>-<ticketId 前 12 位>`，
 *      在 `<repo>/.workmates/` 里按这个后缀匹配；
 *   ③ 扫描 —— `<repo>/.workmates/` 下名字包含任务 ID 或 Ticket 前缀的目录。
 *
 * 端口按 `ports.json` 的键释放：新键 `${proposalId}--${project}--${taskId}`、
 * 无提案时 `${repo}--${taskId}`、旧键 `${proposalId}--${project}`。`project` 是注册表
 * 里的项目名；实现待办自 `5f03447` 起 `repo` 存绝对路径，所以先归一再拼键（见
 * `resolveProject`），路径键只作附加候选兼容误写的表。一个都没命中时**不静默通过**，
 * 而是进"可能泄漏"清单——端口数量有限，泄漏会慢慢毒化后续分配。
 *
 * 用法：
 *   node scripts/rollback-superagent.mjs --dry-run          # 只看会做什么
 *   node scripts/rollback-superagent.mjs                    # 执行（未合并的分支会被拒）
 *   node scripts/rollback-superagent.mjs --task task-abc-1  # 只处理一条
 *   node scripts/rollback-superagent.mjs --force            # 未合并也删（人已确认）
 *
 * 退出码：0 全部按预期；1 有需要人工跟进的项（移除/删除被拒或失败、仓库定位不到、
 * 端口可能泄漏）；2 输入文件损坏（fail-closed，什么都不动）。
 */
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const BRANCH_PREFIX = 'workmate/'
const WORKTREE_SUBDIR = '.workmates'

/**
 * 一个任务的端口键，按新 → 旧排列（释放时逐个尝试）。
 *
 * `repoName` 是 `resolveProject` 归一出的项目名（`ports.json` 的键一直按它写）；
 * 省略时退回 `task.repo` 原值。两者不同（实现待办的 `repo` 是绝对路径）时，
 * 再把路径原值作为**附加候选**——历史上可能已经按路径误写过一条键，
 * 不多试一次就会永远释放不掉。
 */
export function portKeysFor(task, repoName) {
  const repo = String(task.repo ?? '').trim()
  const project = String(repoName ?? task.repo ?? '').trim()
  const taskId = String(task.id ?? '').trim()
  const proposalId = String(task.proposalId ?? '').trim()
  const keys = []
  const push = (key) => {
    if (!keys.includes(key)) keys.push(key)
  }
  if (proposalId !== '') push(`${proposalId}--${project}--${taskId}`)
  push(`${project}--${taskId}`)
  if (proposalId !== '') push(`${proposalId}--${project}`)
  if (repo !== '' && repo !== project) {
    if (proposalId !== '') push(`${proposalId}--${repo}--${taskId}`)
    push(`${repo}--${taskId}`)
    if (proposalId !== '') push(`${proposalId}--${repo}`)
  }
  return keys
}

/** 第二级：Super-agent 的目录名以 `-<ticketId 前 12 位>` 结尾。 */
export function matchByNaming(entries, ticketId) {
  const prefix = String(ticketId ?? '').slice(0, 12)
  if (prefix === '') return []
  return entries.filter((entry) => entry === prefix || entry.endsWith(`-${prefix}`))
}

/** 第三级：名字里带任务 ID 的目录（保守匹配，宁少不错；Ticket 前缀由第二级负责）。 */
export function matchByScan(entries, task) {
  const taskId = String(task.id ?? '')
  if (taskId === '') return []
  return entries.filter((entry) => entry.includes(taskId))
}

/**
 * 纯判定：给定"任务记录 + `.workmates` 下的条目名"，选一个目录名并说明来源。
 * 不猜：三级都没命中就返回 `undefined`；多命中则报错让人收窄范围。
 */
export function locateDirectory(task, entries) {
  const cached = String(task.directory ?? '').trim()
  if (cached !== '') {
    return { name: basename(cached), directory: cached, source: 'cached' }
  }
  const named = matchByNaming(entries, task.ticketId)
  if (named.length === 1) return { name: named[0], directory: '', source: 'naming' }
  if (named.length > 1) {
    return { error: `命名规则命中多个目录：${named.join('、')} — 请用 --task 或手工处理` }
  }
  const scanned = matchByScan(entries, task)
  if (scanned.length === 1) return { name: scanned[0], directory: '', source: 'scan' }
  if (scanned.length > 1) {
    return { error: `扫描命中多个目录：${scanned.join('、')} — 请用 --task 或手工处理` }
  }
  return undefined
}

/** 一个任务是否值得进入回滚流程：有过 Ticket、缓存过目录，或确实被指派过。 */
export function isRollbackCandidate(task) {
  return (
    String(task.ticketId ?? '') !== '' ||
    String(task.directory ?? '') !== '' ||
    (task.mode === 'superagent' && typeof task.attempt === 'number' && task.attempt > 0)
  )
}

/**
 * 把 `task.repo` 归一成注册表里的项目条目与项目名。
 *
 * 为什么需要归一：实现待办自 `5f03447` 起 `repo` 存**绝对路径**（Super-agent 按路径
 * 比对 deployment.repository），而 `projects.json` 与 `ports.json` 的键仍按项目名，
 * 逐字比较 `entry.name === task.repo` 必然失配——目录定位不到、端口键拼不出、
 * 分支也回写不了。匹配顺序：
 *   ① `repo` 是绝对路径 → 按真实路径比 `entry.root`（符号链接下 `/tmp` 与 `/private/tmp`
 *      是同一个仓库，逐字比较会漏）；
 *   ② 否则按项目名逐字比较（历史记录里存的就是项目名）；
 *   ③ 兜底按 `basename(repo)` 比名字——项目通常以目录名注册（多仓同名时可能误配，
 *      但只在 ①② 都没命中时生效，且结果要过后续的目录校验）。
 *
 * 都命中不到时 `project` 为 `undefined`，`repoName` 退回可读的名字（绝对路径取末段），
 * 供报告与端口候选键使用；**是否可回滚由调用方按 `project` 判定**。
 */
export async function resolveProject(context, task) {
  const repo = String(task.repo ?? '').trim()
  const projects = Array.isArray(context?.projects) ? context.projects : []
  if (repo === '') return { project: undefined, repoName: '' }

  if (isAbsolute(repo)) {
    const wanted = await resolveReal(repo)
    for (const entry of projects) {
      if (entry.root === '') continue
      if (await resolveReal(entry.root) === wanted) return { project: entry, repoName: entry.name }
    }
  }
  for (const entry of projects) {
    if (entry.name === repo) return { project: entry, repoName: entry.name }
  }
  const tail = basename(repo)
  if (tail !== '' && tail !== repo) {
    for (const entry of projects) {
      if (entry.name === tail) return { project: entry, repoName: entry.name }
    }
  }
  return { project: undefined, repoName: isAbsolute(repo) ? tail : repo }
}

/** 解析命令行（导出以便测试；未知参数直接报错，避免"看起来跑了"）。 */
export function parseArgs(argv) {
  const options = { dryRun: false, force: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--home') options.home = requireValue(argv, ++index, '--home')
    else if (arg === '--workmate-home') options.workmateHome = requireValue(argv, ++index, '--workmate-home')
    else if (arg === '--task-file') options.taskFile = requireValue(argv, ++index, '--task-file')
    else if (arg === '--task') options.task = requireValue(argv, ++index, '--task')
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`)
  return value
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

/**
 * 读输入。任务表损坏 → `TaskFileCorruptError`（调用方退出码 2，什么都不动）：
 * 坏表下继续删目录等于拿猜测去动别人的磁盘。`projects.json` / `ports.json`
 * 缺失或损坏只是少一路信息，不阻断。
 */
export class TaskFileCorruptError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaskFileCorruptError'
  }
}

export async function loadInputs(options) {
  const home = resolve(options.home ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
  const workmateHome = options.workmateHome ?? 'workmate'
  const root = join(home, workmateHome)
  const taskFile = options.taskFile !== undefined && options.taskFile !== ''
    ? resolve(options.taskFile)
    : join(root, 'tasks.json')

  let tasks = []
  try {
    const parsed = await readJson(taskFile)
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      throw new TaskFileCorruptError(`tasks.json 结构不受支持（需要 version: 1 + tasks 数组）：${taskFile}`)
    }
    tasks = parsed.tasks
  } catch (error) {
    if (error instanceof TaskFileCorruptError) throw error
    if (error && error.code === 'ENOENT') tasks = []
    else throw new TaskFileCorruptError(`tasks.json 不是合法 JSON：${taskFile}`)
  }

  const projects = await readJson(join(root, 'projects.json')).catch(() => [])
  const ports = await readJson(join(root, 'ports.json')).catch(() => ({}))
  // 提案的 targets 记录了回写过的 featureBranch，是分支名最权威的来源
  // （prepare 模板由部署方写，命名可能带自己的前缀）。
  const proposals = await readJson(join(root, 'proposals.json')).catch(() => [])
  return {
    root,
    taskFile,
    tasks,
    projects: Array.isArray(projects) ? projects : [],
    proposals: Array.isArray(proposals) ? proposals : [],
    ports: ports !== null && typeof ports === 'object' && !Array.isArray(ports) ? ports : {},
  }
}

/** `<repo>/.workmates/` 下的条目名；目录不存在视为空。 */
async function worktreeEntries(repoRoot) {
  const names = await readdir(join(repoRoot, WORKTREE_SUBDIR)).catch(() => [])
  return names.filter((name) => !name.startsWith('.'))
}

/** 已注册的 worktree 路径集合（`git worktree list --porcelain`，已解析符号链接）。 */
async function registeredWorktrees(repoRoot) {
  const { stdout } = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { timeout: 15_000 })
  const paths = stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((path) => path !== '')
  // macOS 的 /tmp、/var 都是符号链接：不解析真实路径会让"同一个目录"判成两个。
  return await Promise.all(paths.map((path) => realpath(path).catch(() => path)))
}

/** 解析真实路径；目录不存在时退回原值（比较仍能工作）。 */
const resolveReal = (path) => realpath(path).catch(() => path)

const branchExists = async (repoRoot, branch) =>
  run('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)

const isMerged = async (repoRoot, branch, base) =>
  run('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', branch, base], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)

const pathExists = (path) => stat(path).then(() => true).catch(() => false)

/** 候选里第一个真实存在的分支；都不存在返回 undefined。 */
async function firstExistingBranch(repoRoot, candidates) {
  for (const branch of candidates) {
    if (await branchExists(repoRoot, branch)) return branch
  }
  return undefined
}

/**
 * 分支名候选，按可信度排列：
 *   ① 提案 target 已回写的 `featureBranch`（面板观察到 Ticket 时写的，等于 prepare 实际造的）；
 *   ② `workmate/<目录末段>`（prepare 模板的默认）；
 *   ③ 去掉目录末段的 `workmate-` 前缀再拼（部署方自定命名时常见）。
 * 只认第一个真实存在的，不猜。
 *
 * `repoName` 是 `resolveProject` 归一出的项目名：提案 target 的 `project` 存的是项目名，
 * 而实现待办的 `repo` 是绝对路径，拿路径去比永远命中不到（`featureBranch` 就白回写了）。
 */
export function branchCandidates(task, directoryName, proposals, repoName) {
  const candidates = []
  const project = String(repoName ?? task.repo ?? '').trim()
  const proposal = proposals.find((entry) => entry !== null && typeof entry === 'object' && entry.id === task.proposalId)
  const target = Array.isArray(proposal?.targets)
    ? proposal.targets.find((entry) => entry !== null && typeof entry === 'object' && entry.project === project)
    : undefined
  if (typeof target?.featureBranch === 'string' && target.featureBranch !== '') candidates.push(target.featureBranch)
  if (directoryName !== '') {
    candidates.push(`${BRANCH_PREFIX}${directoryName}`)
    const stripped = directoryName.replace(/^workmate-/, '')
    if (stripped !== directoryName) candidates.push(`${BRANCH_PREFIX}${stripped}`)
  }
  return [...new Set(candidates)]
}

/**
 * 处理一个任务：定位 → 移除 worktree → 删分支 → 释放端口。
 * 每一步独立记录，失败不清空已完成的事实（与归档纪律一致）。
 */
async function rollbackTask(task, context) {
  const { project: repo, repoName } = await resolveProject(context, task)
  const record = {
    taskId: String(task.id ?? ''),
    repo: String(task.repo ?? ''),
    repoName,
    proposalId: String(task.proposalId ?? ''),
    directory: '',
    source: '',
    worktree: 'skipped',
    branch: '',
    branchResult: 'skipped',
    portsReleased: [],
    portLeak: false,
    notes: [],
  }

  if (repo === undefined || repo.root === '') {
    // 定位不到仓库根 = 目录、分支、端口三件事都无从确认。这不是"跳过"，
    // 必须让结论变红、退出码非 0，否则假成功会被当成回滚完了。
    record.worktree = 'unresolved'
    record.branchResult = 'unresolved'
    record.notes.push(`仓库 ${task.repo} 未在 projects.json 注册 — 无法定位目录`)
    record.notes.push('没有仓库根，无法确认 worktree 是否真的没了')
    return withPorts(record, task, context, repoName)
  }

  const entries = await worktreeEntries(repo.root)
  const located = locateDirectory(task, entries)
  if (located === undefined) {
    record.notes.push('三级定位都没有命中目录 — 可能从未创建过，或已被手工清理')
  } else if (located.error !== undefined) {
    record.notes.push(located.error)
  } else {
    record.source = located.source
    record.directory = located.directory !== '' ? located.directory : join(repo.root, WORKTREE_SUBDIR, located.name)
    record.branch = await firstExistingBranch(repo.root, branchCandidates(task, basename(record.directory), context.proposals, repoName)) ?? ''

    const registered = await registeredWorktrees(repo.root).catch(() => [])
    const present = await pathExists(record.directory)
    const registeredMatch = registered.includes(await resolveReal(record.directory))
    if (!present && !registeredMatch) {
      record.worktree = 'absent'
      record.notes.push('目录已不存在')
    } else if (!registeredMatch) {
      // 有目录但不是本仓的 worktree：可能是 prepare 留下的半成品。删目录风险大，交给人。
      record.worktree = 'refused'
      record.notes.push(`目录存在但不是已注册的 worktree — 未删除：${record.directory}`)
    } else if (context.dryRun) {
      record.worktree = 'planned'
    } else {
      const removed = await run('git', ['-C', repo.root, 'worktree', 'remove', '--force', record.directory], { timeout: 30_000 })
        .then(() => true)
        .catch((error) => {
          record.notes.push(`git worktree remove 失败：${error instanceof Error ? error.message : String(error)}`)
          return false
        })
      record.worktree = removed ? 'removed' : 'failed'
      if (removed) await run('git', ['-C', repo.root, 'worktree', 'prune'], { timeout: 15_000 }).catch(() => undefined)
    }

    const base = String(task.baseBranch ?? 'main')
    if (record.branch !== '') {
      if (record.worktree !== 'planned' && record.worktree !== 'removed' && record.worktree !== 'absent') {
        record.branchResult = 'skipped'
        record.notes.push('worktree 未移除，分支保留')
      } else {
        const merged = await isMerged(repo.root, record.branch, base)
        if (!merged && context.force !== true) {
          record.branchResult = 'refused'
          record.notes.push(`分支 ${record.branch} 尚未合并进 ${base} — 确认后再加 --force`)
        } else if (context.dryRun) {
          record.branchResult = 'planned'
        } else {
          const deleted = await run('git', ['-C', repo.root, 'branch', '-D', record.branch], { timeout: 15_000 })
            .then(() => true)
            .catch((error) => {
              record.notes.push(`删除分支失败：${error instanceof Error ? error.message : String(error)}`)
              return false
            })
          record.branchResult = deleted ? 'deleted' : 'failed'
        }
      }
    } else {
      record.branchResult = 'absent'
      const candidates = branchCandidates(task, basename(record.directory), context.proposals, repoName)
      if (candidates.length > 0) record.notes.push(`候选分支都不存在：${candidates.join(' / ')}`)
    }
  }

  return withPorts(record, task, context, repoName)
}

/** 端口释放：新键 / 仓库键 / 旧提案键（外加路径原值候选）都试；一个都没命中就明确告警（不静默通过）。 */
function withPorts(record, task, context, repoName) {
  const keys = portKeysFor(task, repoName)
  for (const key of keys) {
    if (context.ports[key] === undefined) continue
    record.portsReleased.push(key)
    if (!context.dryRun) delete context.ports[key]
  }
  if (record.portsReleased.length === 0) {
    record.portLeak = true
    record.notes.push(`端口可能泄漏：ports.json 中没有 ${keys.join(' / ')}`)
  }
  return record
}

const WORKTREE_TEXT = {
  removed: '已移除',
  planned: '将移除（dry-run）',
  absent: '目录已不存在',
  refused: '拒绝（不是已注册 worktree）',
  failed: '移除失败',
  unresolved: '无法定位（仓库未注册）',
  skipped: '未处理',
}

const BRANCH_TEXT = {
  deleted: '已删除',
  planned: '将删除（dry-run）',
  refused: '拒绝（未合并，需 --force）',
  failed: '删除失败',
  absent: '分支不存在',
  unresolved: '无法定位（仓库未注册）',
  skipped: '未处理',
}

/**
 * 一条记录是否"需要人工跟进"：移除/删除被拒或失败、仓库定位不到、端口可能泄漏。
 * 端口泄漏必须在内——一个端口键都没命中时端口段可能还占着，慢慢毒化后续分配；
 * 只在备注里写一句而结论打绿，等于把未完成的回滚宣告成功。
 */
export function needsFollowUp(record) {
  return (
    record.worktree === 'failed' ||
    record.worktree === 'refused' ||
    record.worktree === 'unresolved' ||
    record.branchResult === 'failed' ||
    record.branchResult === 'refused' ||
    record.branchResult === 'unresolved' ||
    record.portLeak === true
  )
}

/** 人类可读清单：每个任务一段结论 + 逐条备注。回滚不许只打印"完成"。 */
export function formatReport(report) {
  const lines = [
    `WorkMate × Super-agent 回滚${report.dryRun ? '（dry-run，未改动磁盘）' : ''}`,
    `任务文件：${report.taskFile}`,
    `端口表：${report.portsFile}`,
    '',
  ]
  for (const record of report.tasks) {
    const label = record.proposalId !== ''
      ? `${record.taskId}（${record.proposalId} · ${record.repo}）`
      : `${record.taskId}（${record.repo}）`
    lines.push(`· ${label}`)
    lines.push(`  目录      ${record.directory === '' ? '（未定位）' : record.directory}${record.source !== '' ? ` [${record.source}]` : ''}`)
    lines.push(`  worktree  ${WORKTREE_TEXT[record.worktree] ?? record.worktree}`)
    lines.push(`  分支      ${record.branch === '' ? '（无）' : record.branch} — ${BRANCH_TEXT[record.branchResult] ?? record.branchResult}`)
    lines.push(`  端口      ${record.portsReleased.length > 0 ? `已释放 ${record.portsReleased.join('、')}` : '未找到记录'}`)
    for (const note of record.notes) lines.push(`  备注      ${note}`)
  }
  if (report.tasks.length === 0) lines.push('（没有需要回滚的任务）')
  if (report.skipped.length > 0) {
    lines.push('', `跳过 ${report.skipped.length} 条未执行过的任务：${report.skipped.join('、')}`)
  }
  if (report.unmatchedPortKeys.length > 0) {
    lines.push('', `未归属到任务的端口记录（可能是旧提案级分配，请人工核对）：${report.unmatchedPortKeys.join('、')}`)
  }
  const leaks = report.tasks.filter((record) => record.portLeak)
  if (leaks.length > 0) lines.push('', `端口可能泄漏：${leaks.map((record) => record.taskId).join('、')}`)
  const failures = report.tasks.filter(needsFollowUp)
  lines.push('', failures.length === 0 ? '结论：目录与分支已按预期处理。' : `结论：${failures.length} 条需要人工跟进（见备注）。`)
  return lines.join('\n')
}

/** 主流程；返回报告（CLI 与测试共用）。 */
export async function rollback(options) {
  const inputs = await loadInputs(options)
  const context = {
    projects: inputs.projects.map((entry) => ({ name: String(entry.name ?? ''), root: String(entry.root ?? '') })),
    proposals: inputs.proposals,
    ports: { ...inputs.ports },
    dryRun: options.dryRun === true,
    force: options.force === true,
  }
  const selected = options.task === undefined
    ? inputs.tasks
    : inputs.tasks.filter((task) => task.id === options.task)
  if (options.task !== undefined && selected.length === 0) throw new Error(`任务不存在：${options.task}`)

  const candidates = selected.filter(isRollbackCandidate)
  const skipped = selected.filter((task) => !isRollbackCandidate(task)).map((task) => String(task.id ?? ''))

  const records = []
  // 端口键的归属按**归一后的项目名**算（路径原值只是附加候选）；用原始 task.repo 会把
  // 真正释放掉的键算成"未归属"，在报告里误导人。
  const usedKeys = new Set()
  for (const task of candidates) {
    const record = await rollbackTask(task, context)
    records.push(record)
    for (const key of portKeysFor(task, record.repoName)) usedKeys.add(key)
  }

  const report = {
    dryRun: options.dryRun === true,
    taskFile: inputs.taskFile,
    portsFile: join(inputs.root, 'ports.json'),
    tasks: records,
    skipped,
    unmatchedPortKeys: Object.keys(context.ports).filter((key) => !usedKeys.has(key)),
  }

  // 端口表回写：只在真释放过键时写，tmp + rename 保持原子。
  if (!report.dryRun && Object.keys(context.ports).length !== Object.keys(inputs.ports).length) {
    const file = report.portsFile
    await writeFile(`${file}.tmp`, JSON.stringify(context.ports, null, 2) + '\n', 'utf8')
    await rename(`${file}.tmp`, file)
  }
  return report
}

const HELP = `回滚 Super-agent 模式留下的 worktree、分支与端口。

  node scripts/rollback-superagent.mjs [选项]

  --dry-run              只打印计划，不改磁盘
  --force                分支未合并也删除（人已确认）
  --task <id>            只处理一条任务
  --home <dir>           DSH home（默认 $DSH_HOME 或 ~/.dsh）
  --workmate-home <dir>  WorkMate 子目录名（默认 workmate）
  --task-file <path>     tasks.json 的绝对路径（与插件配置一致）
  --json                 输出机器可读的 JSON
`

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help === true) {
      process.stdout.write(HELP)
      process.exit(0)
    }
    const report = await rollback(options)
    process.stdout.write(options.json === true ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n')
    // 与 formatReport 的结论同源：有未解析仓库 / 端口泄漏 / 拒删 / 失败就不是 0。
    process.exit(report.tasks.some(needsFollowUp) ? 1 : 0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    if (error instanceof TaskFileCorruptError) {
      process.stderr.write('任务文件损坏时不做任何改动（fail-closed）——请先修复或备份它。\n')
      process.exit(2)
    }
    process.exit(1)
  }
}
