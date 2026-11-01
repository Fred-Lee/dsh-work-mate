/**
 * `scripts/rollback-superagent.mjs` 的用例（change `adopt-superagent-openspec-source`, task 22）。
 *
 * 两类：纯判定（三级定位 / 端口键 / 参数解析）与真实 git 夹具（真的建 worktree、
 * 真的删）。后者是必要的——"删目录"这种事只有真跑才算验过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  branchCandidates,
  formatReport,
  isRollbackCandidate,
  locateDirectory,
  matchByNaming,
  matchByScan,
  parseArgs,
  portKeysFor,
  rollback,
} from './rollback-superagent.mjs'

const run = promisify(execFile)

const git = async (cwd, args) => {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 20_000 })
  return stdout
}

/** 一个带初始提交的仓库；测试结束由调用方 rm -rf 临时目录。 */
async function makeRepo(prefix = 'rollback-repo-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'Test'])
  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-q', '-m', 'init'])
  return root
}

async function makeHome(tasks, ports = {}, projects = []) {
  const home = await mkdtemp(join(tmpdir(), 'rollback-home-'))
  const root = join(home, 'workmate')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'tasks.json'), JSON.stringify({ version: 1, tasks }, null, 2), 'utf8')
  await writeFile(join(root, 'ports.json'), JSON.stringify(ports, null, 2), 'utf8')
  await writeFile(join(root, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
  return home
}

const task = (overrides = {}) => ({
  id: 'task-1',
  title: '修复颜色',
  intent: '修复颜色',
  repo: 'demo',
  baseBranch: 'main',
  acceptance: '',
  priority: 'P1',
  mode: 'superagent',
  dependsOn: [],
  assigned: true,
  abandoned: false,
  attempt: 1,
  createdBy: 'workmate:panel',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...overrides,
})

test('portKeysFor tries the task key, the repo key, then the legacy proposal key', () => {
  assert.deepEqual(portKeysFor({ id: 't1', repo: 'demo', proposalId: 'p1' }), [
    'p1--demo--t1',
    'demo--t1',
    'p1--demo',
  ])
  assert.deepEqual(portKeysFor({ id: 't1', repo: 'demo' }), ['demo--t1'])
})

test('matchByNaming keys on the 12-character ticket prefix', () => {
  const entries = ['workmate-fix-color-abcdef123456', 'workmate-other-999999999999']
  assert.deepEqual(matchByNaming(entries, 'abcdef1234567890'), ['workmate-fix-color-abcdef123456'])
  assert.deepEqual(matchByNaming(entries, ''), [])
})

test('matchByScan falls back to the task id and stays conservative', () => {
  const entries = ['workmate-fix-color-abcdef123456', 'workmate-task-7-111111111111', 'unrelated']
  assert.deepEqual(matchByScan(entries, { id: 'task-7', ticketId: '' }), ['workmate-task-7-111111111111'])
  assert.deepEqual(matchByScan(entries, { id: 'task-9', ticketId: 'abcdef123456' }), [])
})

test('locateDirectory prefers the cached directory over naming and scan', () => {
  const cached = locateDirectory(
    { id: 't1', directory: '/repo/.workmates/workmate-cached-aaaaaaaaaaaa', ticketId: 'bbbbbbbbbbbb' },
    ['workmate-scanned-task-1'],
  )
  assert.equal(cached.source, 'cached')
  assert.equal(cached.name, 'workmate-cached-aaaaaaaaaaaa')

  const named = locateDirectory({ id: 't1', ticketId: 'abcdef123456' }, ['workmate-x-abcdef123456'])
  assert.equal(named.source, 'naming')

  const scanned = locateDirectory({ id: 'task-3' }, ['workmate-thing-task-3'])
  assert.equal(scanned.source, 'scan')
})

test('locateDirectory refuses to guess when several directories match', () => {
  const named = locateDirectory({ id: 't1', ticketId: 'abcdef123456' }, [
    'workmate-a-abcdef123456',
    'workmate-b-abcdef123456',
  ])
  assert.match(named.error, /命中多个目录/)

  const scanned = locateDirectory({ id: 'task-3' }, ['workmate-task-3-a', 'workmate-task-3-b'])
  assert.match(scanned.error, /命中多个目录/)
})

test('locateDirectory returns undefined when nothing matches', () => {
  assert.equal(locateDirectory({ id: 't9' }, ['workmate-other-111111111111']), undefined)
})

test('branchCandidates prefers the writeback target branch over naming', () => {
  const proposals = [
    { id: 'p1', targets: [{ project: 'demo', baseBranch: 'main', featureBranch: 'workmate/drill-aaaaaaaaaaaa' }] },
  ]
  assert.deepEqual(branchCandidates({ proposalId: 'p1', repo: 'demo' }, 'workmate-drill-aaaaaaaaaaaa', proposals), [
    'workmate/drill-aaaaaaaaaaaa',
    'workmate/workmate-drill-aaaaaaaaaaaa',
    'workmate/drill-aaaaaaaaaaaa',
  ].filter((value, index, all) => all.indexOf(value) === index))
  assert.deepEqual(branchCandidates({ repo: 'demo' }, 'fix-color-abcdef123456', proposals), [
    'workmate/fix-color-abcdef123456',
  ])
  assert.deepEqual(branchCandidates({ repo: 'demo' }, '', proposals), [])
})

test('isRollbackCandidate skips tasks that never reached the executor', () => {
  assert.equal(isRollbackCandidate(task({ mode: 'record', attempt: 0 })), false)
  assert.equal(isRollbackCandidate(task({ mode: 'superagent', attempt: 1 })), true)
  assert.equal(isRollbackCandidate(task({ mode: 'record', attempt: 0, ticketId: 'abc' })), true)
})

test('parseArgs rejects unknown flags and flag-without-value', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--force', '--task', 't1']), {
    dryRun: true,
    force: true,
    json: false,
    task: 't1',
  })
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
  assert.throws(() => parseArgs(['--task']), /需要一个值/)
  assert.throws(() => parseArgs(['--home', '--force']), /需要一个值/)
})

test('rollback removes the worktree, deletes the merged branch and frees ports', async () => {
  const repo = await makeRepo()
  try {
    await mkdir(join(repo, '.workmates'), { recursive: true })
    const dir = join(repo, '.workmates', 'workmate-fix-color-abcdef123456')
    const branch = 'workmate/workmate-fix-color-abcdef123456'
    await git(repo, ['worktree', 'add', '-q', '-b', branch, dir])
    // 合并回基线，满足"已合并才删分支"的前置。
    await git(repo, ['merge', '-q', '--ff-only', branch])

    const home = await makeHome(
      [task({ ticketId: 'abcdef123456', directory: '', id: 'task-1', proposalId: 'p1' })],
      {
        'p1--demo--task-1': { base: 4100, ports: [4100, 4101, 4102, 4103, 4104] },
        'demo--task-1': { base: 4200, ports: [4200, 4201, 4202, 4203, 4204] },
      },
      [{ name: 'demo', root: repo }],
    )
    try {
      const report = await rollback({ home, workmateHome: 'workmate' })
      assert.equal(report.tasks.length, 1)
      const record = report.tasks[0]
      assert.equal(record.worktree, 'removed')
      assert.equal(record.branchResult, 'deleted')
      assert.deepEqual(record.portsReleased, ['p1--demo--task-1', 'demo--task-1'])
      assert.equal(existsSync(dir), false)

      const listed = await git(repo, ['branch', '--list', branch])
      assert.equal(listed.trim(), '')

      const ports = JSON.parse(await readFile(join(home, 'workmate', 'ports.json'), 'utf8'))
      assert.deepEqual(ports, {})
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('rollback refuses the branch when it is not merged, and keeps the worktree', async () => {
  const repo = await makeRepo()
  try {
    await mkdir(join(repo, '.workmates'), { recursive: true })
    const dir = join(repo, '.workmates', 'workmate-unmerged-111111111111')
    const branch = 'workmate/workmate-unmerged-111111111111'
    await git(repo, ['worktree', 'add', '-q', '-b', branch, dir])
    await writeFile(join(dir, 'work.txt'), 'unmerged\n', 'utf8')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-q', '-m', 'unmerged work'])

    const home = await makeHome(
      [task({ id: 'task-2', ticketId: '111111111111', directory: dir })],
      {},
      [{ name: 'demo', root: repo }],
    )
    try {
      const report = await rollback({ home, workmateHome: 'workmate' })
      const record = report.tasks[0]
      // 目录已被移除（worktree remove --force 允许），但分支必须保留。
      assert.equal(record.worktree, 'removed')
      assert.equal(record.branchResult, 'refused')
      assert.match(record.notes.join('\n'), /尚未合并/)
      const listed = await git(repo, ['branch', '--list', branch])
      assert.match(listed, /workmate\/workmate-unmerged-111111111111/)
      assert.equal(record.portLeak, true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('rollback --force deletes an unmerged branch', async () => {
  const repo = await makeRepo()
  try {
    await mkdir(join(repo, '.workmates'), { recursive: true })
    const dir = join(repo, '.workmates', 'workmate-forced-222222222222')
    const branch = 'workmate/workmate-forced-222222222222'
    await git(repo, ['worktree', 'add', '-q', '-b', branch, dir])
    await writeFile(join(dir, 'work.txt'), 'wip\n', 'utf8')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-q', '-m', 'wip'])

    const home = await makeHome(
      [task({ id: 'task-3', ticketId: '222222222222', directory: dir })],
      { 'demo--task-3': { base: 4200, ports: [4200] } },
      [{ name: 'demo', root: repo }],
    )
    try {
      const report = await rollback({ home, workmateHome: 'workmate', force: true })
      assert.equal(report.tasks[0].branchResult, 'deleted')
      assert.equal((await git(repo, ['branch', '--list', branch])).trim(), '')
      assert.equal(report.tasks[0].portLeak, false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('dry-run reports the plan and touches nothing', async () => {
  const repo = await makeRepo()
  try {
    await mkdir(join(repo, '.workmates'), { recursive: true })
    const dir = join(repo, '.workmates', 'workmate-dry-333333333333')
    const branch = 'workmate/workmate-dry-333333333333'
    await git(repo, ['worktree', 'add', '-q', '-b', branch, dir])
    await git(repo, ['merge', '-q', '--ff-only', branch])

    const home = await makeHome(
      [task({ id: 'task-4', ticketId: '333333333333', directory: dir })],
      { 'demo--task-4': { base: 4300, ports: [4300] } },
      [{ name: 'demo', root: repo }],
    )
    try {
      const report = await rollback({ home, workmateHome: 'workmate', dryRun: true })
      assert.equal(report.dryRun, true)
      assert.equal(report.tasks[0].worktree, 'planned')
      assert.equal(report.tasks[0].branchResult, 'planned')
      assert.equal(existsSync(dir), true)
      assert.match(await git(repo, ['branch', '--list', branch]), /workmate-dry/)
      const ports = JSON.parse(await readFile(join(home, 'workmate', 'ports.json'), 'utf8'))
      assert.ok(ports['demo--task-4'] !== undefined)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('a corrupt task file aborts before touching the disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rollback-corrupt-'))
  try {
    const root = join(home, 'workmate')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'tasks.json'), '{ not json', 'utf8')
    await assert.rejects(() => rollback({ home, workmateHome: 'workmate' }), /不是合法 JSON/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unregistered repo is reported instead of silently skipped', async () => {
  const home = await makeHome([task({ id: 'task-5', ticketId: '444444444444', repo: 'ghost' })], {}, [])
  try {
    const report = await rollback({ home, workmateHome: 'workmate' })
    const record = report.tasks[0]
    assert.equal(record.worktree, 'skipped')
    assert.match(record.notes.join('\n'), /未在 projects\.json 注册/)
    assert.equal(record.portLeak, true)
    assert.match(formatReport(report), /端口可能泄漏/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('formatReport prints per-item conclusions, not just "done"', () => {
  const text = formatReport({
    dryRun: false,
    taskFile: '/tmp/tasks.json',
    portsFile: '/tmp/ports.json',
    skipped: ['task-9'],
    unmatchedPortKeys: ['p0--demo'],
    tasks: [
      {
        taskId: 'task-1',
        repo: 'demo',
        proposalId: 'p1',
        directory: '/repo/.workmates/workmate-x-aaaaaaaaaaaa',
        source: 'cached',
        worktree: 'removed',
        branch: 'workmate/workmate-x-aaaaaaaaaaaa',
        branchResult: 'deleted',
        portsReleased: ['p1--demo--task-1'],
        portLeak: false,
        notes: [],
      },
    ],
  })
  assert.match(text, /task-1（p1 · demo）/)
  assert.match(text, /已移除/)
  assert.match(text, /已删除/)
  assert.match(text, /已释放 p1--demo--task-1/)
  assert.match(text, /跳过 1 条/)
  assert.match(text, /未归属到任务的端口记录/)
})
