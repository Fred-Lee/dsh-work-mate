/**
 * 本地引擎级端到端演练（change `adopt-superagent-openspec-source`, task 28 的离线部分）。
 *
 * 为什么需要它：真机验收的最后一段需要 GitHub 账号（`gh auth login`）与一个可写仓库，
 * 本机没有凭据时跑不起来。但**Ticket 生命周期、worktree 创建、Channel 回写、回收**
 * 都不依赖 GitHub——它们只依赖 Super-agent 的 `Engine` 与本来源自己的代码。
 *
 * 这里用的都是真代码，不是替身：
 *   - Super-agent 的 `Engine` / `MemoryRepositories` / `ticketStage`（`lib/index.js`）
 *   - Super-agent 的**真实**门禁 `settingsPolicy`（`src/policy.ts`）
 *   - 本仓库的 `buildTaskTrigger` / `buildInputTrigger` / `scanOnce` / `createChannel`
 *     / `environmentValues` / `PREPARE_SNIPPET` / `projectTask` / `reclaimOne`
 *     / `PortAllocator` / `appendResult` / `compactResults`
 *
 * 只有两处是脚本扮演的，且都在输出里标明：
 *   - worker 的 `engine.report(...)`（真机里由 DSH worker 会话触发）；
 *   - 打开并关闭一个 PR 线程（真机里由 GitHub Source 的 `bindThread` / `threadClosed` 触发）。
 *
 * 用法：
 *   node --experimental-transform-types scripts/verify-superagent-offline.mjs \
 *        --superagent /path/to/dsh-superagent-prototype [--keep]
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const git = async (cwd, args) => (await exec('git', ['-C', cwd, ...args], { timeout: 30_000 })).stdout

export const parseArgs = (argv) => {
  const options = { superagent: process.env['SUPERAGENT_ROOT'] ?? '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--superagent') options.superagent = argv[++index]
    else if (arg === '--keep') options.keep = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

/** 真实 Ticket → 面板投影输入（与 `views/tickets.ts` 的 ticketSummary 同形）。 */
export const ticketView = (ticket, ticketStage) => {
  const stage = ticketStage(ticket)
  return {
    id: ticket.id,
    title: ticket.title,
    stage: stage.stage,
    ...(stage.action !== undefined ? { action: stage.action } : {}),
    ...(ticket.ended !== undefined ? { ended: { outcome: ticket.ended.outcome, at: ticket.ended.at } } : {}),
    ...(ticket.execution?.directory !== undefined ? { directory: ticket.execution.directory } : {}),
    ...(ticket.attention?.question !== undefined ? { attention: { question: ticket.attention.question } } : {}),
  }
}

/** 演练主流程：返回逐项结果与（保留目录时的）现场路径。 */
export async function drill(options) {
  const superagent = options.superagent === '' ? '' : resolve(options.superagent)
  if (superagent === '' || !existsSync(join(superagent, 'lib', 'index.js'))) {
    throw new Error('需要 Super-agent 源码仓库且已构建：--superagent <path>（lib/index.js 必须存在）')
  }

  const core = await import(`file://${join(superagent, 'lib', 'index.js')}`)
  const { Engine, MemoryRepositories, ticketStage } = core
  const { settingsPolicy, SettingsSchema } = await import(`file://${join(superagent, 'src', 'policy.ts')}`)

  const repoRootDir = resolve(import.meta.dirname, '..')
  const load = (path) => import(`file://${join(repoRootDir, path)}`)
  const { buildTaskTrigger, buildInputTrigger, scanOnce } = await load('packages/superagent-source/src/watch.ts')
  const { createChannel } = await load('packages/superagent-source/src/channel.ts')
  const { readResults } = await load('packages/superagent-source/src/files.ts')
  const { appendResult, compactResults } = await load('packages/superagent-source/src/files.ts')
  const { environmentValues, PREPARE_SNIPPET } = await load('packages/superagent-source/src/environment.ts')
  const { projectTask } = await load('src/features/superagent/project.ts')
  const { reclaimOne } = await load('src/features/task/reclaim.ts')
  const { PortAllocator } = await load('src/features/worktree/port-allocator.ts')
  const { planTaskPorts } = await load('src/features/task/plan.ts')

  const notes = []
  const problems = []
  const section = (title) => notes.push(`\n## ${title}`)
  const check = (label, ok, detail = '') => {
    notes.push(`  ${ok ? '✔' : '✘'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
    if (!ok) problems.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  }

  const temp = await mkdtemp(join(process.env['TMPDIR'] ?? '/tmp', 'wm-engine-drill-'))
  const homeRoot = join(temp, 'home')            // WorkMate 落盘（ports.json）
  const stateDir = join(temp, 'state')           // 执行根（等价 Super-agent 的 stateDir/work）
  const repoRoot = join(temp, 'demo-repo')
  const tasksDir = join(temp, 'tasks')
  const taskFile = join(tasksDir, 'tasks.json')
  const resultsFile = join(tasksDir, 'tasks.jsonl')
  await Promise.all([mkdir(homeRoot, { recursive: true }), mkdir(tasksDir, { recursive: true })])
  const worktreesRoot = join(repoRoot, '.workmates')

  // ---- 真实 git 仓库 ----
  await mkdir(repoRoot, { recursive: true })
  await git(repoRoot, ['init', '-q', '-b', 'main'])
  await git(repoRoot, ['config', 'user.email', 'agent@example.com'])
  await git(repoRoot, ['config', 'user.name', 'Drill Agent'])
  await writeFile(join(repoRoot, 'README.md'), '# demo\n', 'utf8')
  await git(repoRoot, ['add', '.'])
  await git(repoRoot, ['commit', '-q', '-m', 'init'])

  const task = {
    id: 'task-drill-1',
    title: '给 README 加一行',
    intent: '在 README 顶部加一行：本文件用于 WorkMate × Super-agent 引擎级演练。',
    repo: 'demo',
    baseBranch: 'main',
    acceptance: 'README 多出这一行，内容一致',
    priority: 'P1',
    mode: 'superagent',
    dependsOn: [],
    assigned: true,
    abandoned: false,
    attempt: 1,
    createdBy: 'workmate:panel',
    proposalId: 'drill-proposal',
    createdAt: '2026-11-01T19:00:00.000Z',
    updatedAt: '2026-11-01T19:00:00.000Z',
  }
  let currentTasks = [task]

  // 真实端口分配：键与 WorkMate 的 plan.ts 一致（`${proposalId}--${project}--${taskId}`）。
  const ports = new PortAllocator({ homeRoot, subdir: 'wm' }, 4300, 10)
  task.ports = await planTaskPorts(ports, { proposalId: task.proposalId, project: task.repo, taskId: task.id })
  const config = {
    taskFile,
    pollSeconds: 5,
    maxPerScan: 5,
    maxRowsPerTask: 6,
    interactive: true,
    copyFiles: ['.env'],
    openspecRoot: 'openspec',
  }

  // ---- 真实 Settings + 真实门禁 ----
  const settings = SettingsSchema.parse({
    sources: { workmate: { enabled: true, config } },
    policy: { sources: { workmate: { allowed: [{ id: 'workmate:panel' }] } } },
    eval: { mode: 'observe' },
    executor: { directory: worktreesRoot, prepare: PREPARE_SNIPPET },
  })
  const sourceScope = { scope: () => ({ listened: true, observed: false }) }
  const policy = settingsPolicy(settings, sourceScope)

  // ---- 真实 Engine 的端口 ----
  const repo = new MemoryRepositories()
  const candidates = []
  const assessor = { request: (candidate) => candidates.push(candidate) }
  const launches = []
  const executor = {
    start: (ticket) => launches.push(ticket.id),
    deliver: () => undefined,
    stop: () => undefined,
  }
  const receipts = new Map()
  const channel = createChannel({ taskFile: () => taskFile, currentTasks: () => currentTasks })
  const outbox = {
    send: (message) => { if (!receipts.has(message.id)) receipts.set(message.id, { status: 'pending', message }) },
    status: (id) => receipts.get(id)?.status,
    withdraw: (id) => receipts.delete(id),
  }
  const sentRows = []
  /** 真实的 Outbox 投递循环：逐条走我们的 Channel，结果写进 tasks.jsonl。 */
  const flush = async () => {
    for (const [id, receipt] of [...receipts]) {
      if (receipt.status !== 'pending') continue
      const result = await channel.send({}, receipt.message)
      receipts.set(id, { ...receipt, status: result === 'gone' ? 'gone' : 'sent' })
      sentRows.push({ id, kind: receipt.message.kind, result })
    }
  }

  let clock = 0
  // 每次调用 +1 分钟：让"回答(19:05) → ready 报告(19:0x)"的先后成立（`unfinished` 按时间戳判断）。
  const now = () => new Date(Date.UTC(2026, 10, 1, 19, clock++)).toISOString()
  const engine = new Engine({
    repo,
    policy: () => policy,
    scope: sourceScope,
    assessor,
    executor,
    outbox,
    // 与 `executor/dsh.ts` 的 `ticketExecution` 同规则：`<执行根>/<短名>-<ticketId 前 12 位>`。
    prepareTicket: (ticket, outcome) => {
      const short = (outcome.name ?? 'drill').replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 32) || 'drill'
      const name = `${short}-${ticket.id.slice(0, 12)}`
      return { ...ticket, execution: { name, directory: join(settings.executor.directory, name), assignment: outcome.note ?? '' } }
    },
    now,
  })

  // ================================================================
  section('C.1 扫描 → Trigger → 真实门禁')
  let cursor = 0
  const scan = await scanOnce(
    {
      receive: (trigger) => engine.receive(trigger),
      terminalOf: () => undefined,
      readCursor: () => cursor,
      writeCursor: (seq) => { cursor = seq },
    },
    { tasks: [task], inputs: [], maxPerScan: 5, interactive: true, now: () => new Date('2026-11-01T19:00:00.000Z') },
  )
  check('scanOnce 投递 1 条待办', scan.submitted.length === 1, `submitted=${scan.submitted.join(',')}`)
  engine.evaluateDue()
  const candidate = candidates.at(-1)
  check('Eval 拿到候选', candidate !== undefined)
  check('真实门禁判为 explicit', candidate?.strength === 'explicit', `strength=${candidate?.strength}`)
  const basis = candidate?.thread?.evaluating?.basis
  check('门禁 basis 记录来源与名单', basis?.via === 'addressed' && basis.source === 'workmate' && basis.sender !== undefined, `via=${basis?.via} sender=${basis?.sender}`)

  section('C.2 accept → Ticket → working/queued')
  const originTrigger = buildTaskTrigger(task, '2026-11-01T19:00:00.000Z')
  const decision = engine.decide(originTrigger.id, {
    kind: 'accept',
    title: '给 README 加一行',
    scope: 'small',
    reason: '面板里的明确请求',
    acknowledgement: '收到，开始处理',
    name: 'readme-line',
  })
  await flush()
  const ticketId = decision.ticketId
  const ticketAfterAccept = repo.tickets.get(ticketId)
  check('decision 建出 Ticket', ticketId !== undefined, `ticketId=${ticketId}`)
  check('executor.start 被调用一次', launches.length === 1)
  const firstView = projectTask({ task, ticket: ticketView(ticketAfterAccept, ticketStage), submitted: true })
  check('面板投影 = 执行中/排队中', firstView.lane === 'working' && firstView.substate === 'queued', `${firstView.lane}/${firstView.substate}`)
  const ackRows = (await readResults(resultsFile)).rows
  check('ack 经真实 Channel 写入 tasks.jsonl', ackRows.some((row) => row.kind === 'ack' && row.ticketId === ticketId), `rows=${ackRows.length}`)
  check('messageId 是 32 位十六进制（Super-agent 的 key 格式）', ackRows.every((row) => /^[0-9a-f]{32}$/.test(row.messageId ?? '')), ackRows.map((row) => row.messageId).join(','))

  section('C.3 assignmentStarted → working')
  const assignmentId = ticketAfterAccept.assignments.at(-1).id
  engine.assignmentStarted(ticketId, assignmentId)
  const workingView = projectTask({ task, ticket: ticketView(repo.tickets.get(ticketId), ticketStage), submitted: true })
  check('面板投影 = 执行中/执行中', workingView.lane === 'working' && workingView.substate === 'working', `${workingView.lane}/${workingView.substate}`)

  section('D. 真实 prepare 建 worktree（PREPARE_SNIPPET + 真实环境变量）')
  const env = environmentValues({ deployment: { repository: 'demo/demo' }, config, trigger: originTrigger })
  check('_TASK / _BASE_BRANCH / _PORTS 来自 meta', env.DSH_SUPERAGENT_WORKMATE_TASK === task.id && env.DSH_SUPERAGENT_WORKMATE_BASE_BRANCH === 'main', `task=${env.DSH_SUPERAGENT_WORKMATE_TASK} base=${env.DSH_SUPERAGENT_WORKMATE_BASE_BRANCH}`)
  check('_COPY 来自实例配置', env.DSH_SUPERAGENT_WORKMATE_COPY === '.env')
  const directory = ticketAfterAccept.execution.directory
  const name = ticketAfterAccept.execution.name
  check('目录名符合 <短名>-<12 位>', new RegExp(`^[a-z]+(?:-[a-z0-9]+){0,3}-${ticketId.slice(0, 12)}$`).test(name), name)
  check('目录位于 <repo>/.workmates', directory.startsWith(`${worktreesRoot}/`), directory)
  check('prepare 前目录不存在（重要：预先存在会让 prepare 被跳过）', !existsSync(directory))
  // 宿主在跑 prepare 前会 `mkdir(dirname(directory))`（`executor/dsh.ts:248-249`）；照做。
  await mkdir(worktreesRoot, { recursive: true })
  // prepare 与 worker 拿同一批执行变量（docs/003-execution.md:65），所以用一次真实的
  // `sh -c 'env'` 就能证明 worker 侧会看到它们。
  const { DSH_SUPERAGENT_WORKMATE_PORTS, ...prepareEnv } = env
  void DSH_SUPERAGENT_WORKMATE_PORTS
  const shellEnv = await exec('sh', ['-c', 'env'], {
    cwd: tasksDir,
    timeout: 15_000,
    env: { ...process.env, DSH_SUPERAGENT_NAME: name, DSH_SUPERAGENT_DIR: directory, ...env, DSH_SUPERAGENT_WORKMATE_PORTS: '4300,4301,4302,4303,4304' },
  }).then((result) => result.stdout)
  const wanted = ['TASK', 'ACCEPTANCE', 'PRIORITY', 'BASE_BRANCH', 'PORTS', 'COPY', 'PROPOSAL']
  const missing = wanted.filter((key) => !new RegExp(`^DSH_SUPERAGENT_WORKMATE_${key}=`, 'm').test(shellEnv))
  check('worker/prepare 的 shell 里 7 个执行变量都可见', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : wanted.join(', '))
  check('_PORTS 是逗号分隔的端口段', /^DSH_SUPERAGENT_WORKMATE_PORTS=4300,4301,4302,4303,4304$/m.test(shellEnv))
  await exec('sh', ['-c', PREPARE_SNIPPET], {
    cwd: worktreesRoot,
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: process.env['PATH'] ?? '',
      DSH_SUPERAGENT_NAME: name,
      DSH_SUPERAGENT_DIR: directory,
      ...env,
      DSH_SUPERAGENT_WORKMATE_PORTS: '4300,4301,4302,4303,4304',
    },
  })
  check('prepare 建出目录', existsSync(directory), directory)
  const registered = (await git(repoRoot, ['worktree', 'list', '--porcelain']))
    .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9).trim())
  check('仓库里恰好两个 worktree（主检出 + 该 Ticket）', registered.length === 2, registered.join(' | '))
  const { realpath } = await import('node:fs/promises')
  const realRegistered = await Promise.all(registered.map((path) => realpath(path).catch(() => path)))
  check('目录已注册为本仓 worktree', realRegistered.includes(await realpath(directory)))
  const worktreeBranch = (await git(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  check('分支 = workmate/<Ticket 短名>', worktreeBranch === `workmate/${name}`, worktreeBranch)
  const dotenv = await readFile(join(directory, '.env'), 'utf8')
  check('.env 写入 WORKMATE_PORT / WORKMATE_PORTS', dotenv.includes('WORKMATE_PORT=4300') && dotenv.includes('WORKMATE_PORTS=4300,4301,4302,4303,4304'))
  void prepareEnv

  section('D.2 prepare 失败可见（基线分支不存在）')
  const badDir = join(worktreesRoot, 'bad-base-000000000000')
  const badRun = await exec('sh', ['-c', PREPARE_SNIPPET], {
    cwd: worktreesRoot,
    timeout: 120_000,
    env: { ...process.env, DSH_SUPERAGENT_NAME: 'bad-base-000000000000', DSH_SUPERAGENT_DIR: badDir, ...env, DSH_SUPERAGENT_WORKMATE_BASE_BRANCH: 'no-such-branch' },
  }).then(() => ({ ok: true, output: '' }), (error) => ({ ok: false, output: `${error.stderr ?? ''}${error.stdout ?? ''}` }))
  check('prepare 以非零退出（宿主会因此判 Ticket 失败）', badRun.ok === false, badRun.ok ? '命令竟然成功了' : 'exit≠0')
  check('失败输出带得上（面板能显示原因）', /no-such-branch|not a commit|invalid reference/i.test(badRun.output), badRun.output.trim().split('\n').slice(-1)[0] ?? '')
  check('失败后没有留下目录（宿主会 rmdir）', !existsSync(badDir))

  section('C.4 person/answer → 回答 → 继续')
  engine.report(ticketId, { state: 'progress', summary: '已改好，待验证', question: '用 main 作为对照分支？' })
  const answerView = projectTask({ task, ticket: ticketView(repo.tickets.get(ticketId), ticketStage), submitted: true })
  check('面板投影 = 需要我/待回答', answerView.lane === 'attention' && answerView.substate === 'answer', `${answerView.lane}/${answerView.substate}`)
  check('投影带出提问原文', answerView.note === '用 main 作为对照分支？', answerView.note)

  const inputRow = { seq: 1, taskId: task.id, text: '是，用 main。', by: 'workmate:panel', at: '2026-11-01T19:05:00.000Z' }
  const inputTrigger = buildInputTrigger(inputRow, task)
  check('人回答的 Trigger 与指派同 Thread', JSON.stringify(inputTrigger.threads) === JSON.stringify(originTrigger.threads))
  const received = engine.receive(inputTrigger)
  check('回答被接收（stored）', received === 'stored', received)
  const inputId = `input-${ticketId}-${inputTrigger.id}` // 仅用于下面找 input，不参与断言
  void inputId
  const withInput = repo.tickets.get(ticketId)
  check('回答进入 Ticket 的 undelivered', withInput.undelivered.length >= 1, `undelivered=${withInput.undelivered.length}`)
  const undeliveredId = withInput.undelivered.at(-1)
  engine.inputsDelivered(ticketId, assignmentId, [undeliveredId])
  // 真机里 worker 的会话把输入读进一轮才会调 `inputsRead`；不调的话 Ticket 会一直
  // 判定为"有未读完的输入"，PR 关闭后也不会结束（下面的 merged 断言会因此失败）。
  engine.inputsRead(ticketId, [undeliveredId])
  engine.report(ticketId, { state: 'progress', summary: '收到回答，继续', question: null, answers: inputTrigger.id })
  const answered = await engine.reply({ purpose: 'answer', ticketId, triggerId: inputTrigger.id, text: '收到，用 main 作对照。' })
  await flush()
  check('answer 回复经 Channel 送达', answered.status === 'sent' || sentRows.some((row) => row.kind === 'reply'), `status=${answered.status}`)
  const replyRows = (await readResults(resultsFile)).rows
  check('tasks.jsonl 出现 reply 行', replyRows.some((row) => row.kind === 'reply'), `kinds=${replyRows.map((row) => row.kind).join(',')}`)

  section('C.5 person/review → ended/merged（用一个「PR 线程」扮演 GitHub 绑定）')
  engine.bindThread(ticketId, { source: 'workmate', id: 'pr:1' }, true)
  engine.report(ticketId, { state: 'ready', summary: 'README 已加好一行', question: null })
  const reviewView = projectTask({ task, ticket: ticketView(repo.tickets.get(ticketId), ticketStage), submitted: true })
  check('面板投影 = 需要我/待验收', reviewView.lane === 'attention' && reviewView.substate === 'review', `${reviewView.lane}/${reviewView.substate}`)
  check('Ticket 尚未结束（等 PR 线程关闭）', repo.tickets.get(ticketId).ended === undefined)
  engine.threadClosed({ source: 'workmate', id: 'pr:1' }, 'merged', '2026-11-01T19:10:00.000Z')
  const endedTicket = repo.tickets.get(ticketId)
  check('线程合并后 Ticket 以 merged 结束', endedTicket.ended?.outcome === 'merged', `outcome=${endedTicket.ended?.outcome}`)
  const doneView = projectTask({ task, ticket: ticketView(endedTicket, ticketStage), submitted: true })
  check('面板投影 = 已完成/已合并', doneView.lane === 'done' && doneView.substate === 'merged', `${doneView.lane}/${doneView.substate}`)

  section('E. Channel：result、gone、压缩')
  const result = await engine.reply({ purpose: 'result', ticketId, text: '已合并到 main。' })
  await flush()
  check('result 回复在 Ticket 结束后仍可送达', result.status === 'sent' || sentRows.some((row) => row.result === 'sent'), `status=${result.status}`)
  currentTasks = []
  await writeFile(taskFile, `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`, 'utf8')
  const gone = await channel.send({}, {
    id: 'a'.repeat(32),
    channel: { source: 'workmate', thread: task.id, address: { taskId: task.id } },
    text: '待办已删除后的消息',
    kind: 'notice',
  })
  check('待办被删除后 Channel 返回 gone（不再重试）', gone === 'gone', gone)
  const before = (await readResults(resultsFile)).rows.length
  for (let index = 0; index < 12; index += 1) {
    await appendResult(resultsFile, {
      seq: 100 + index,
      taskId: task.id,
      kind: 'notice',
      messageId: String(index).padStart(32, '0').replace(/[0-9]/g, (digit) => 'abcdef0123456789'[Number(digit)]),
      text: `噪声 ${index}`,
      at: `2026-11-01T19:2${index % 10}:00.000Z`,
    })
  }
  const compacted = await compactResults(resultsFile, 6)
  const after = (await readResults(resultsFile)).rows
  check('压缩删除了行', compacted.removed > 0, `removed=${compacted.removed}（压缩前 ${before} → 压缩后 ${after.length}）`)
  check('压缩保留至少一条 ack', after.some((row) => row.kind === 'ack'))
  // 上限之外会额外保留一条 ack 与最后一条结果（`compactResults` 的保留规则），所以允许 +2。
  check('压缩后行数受上限约束（含保留项）', after.length <= 8, `rows=${after.length}（上限 6）`)

  section('C.6 stop 与 retry（第二条待办，不动已合并的那一条）')
  // retry 的前置很严（`core/tickets.ts` 的 retry）：只有**未结束**、worker 最近一次
  // 报告是 failed/blocked、之后没有人发言的 Ticket 才能重试。用一条独立待办走这条路。
  const task2 = { ...task, id: 'task-drill-2', title: '写一行 CHANGELOG', intent: '在 CHANGELOG 里加一行。', proposalId: undefined }
  currentTasks = [task]
  await writeFile(taskFile, `${JSON.stringify({ version: 1, tasks: [task, task2] }, null, 2)}\n`, 'utf8')
  await scanOnce(
    {
      receive: (trigger) => engine.receive(trigger),
      terminalOf: () => undefined,
      readCursor: () => 0,
      writeCursor: () => undefined,
    },
    { tasks: [task2], inputs: [], maxPerScan: 5, interactive: true, now: () => new Date('2026-11-01T19:30:00.000Z') },
  )
  engine.evaluateDue()
  const candidate2 = candidates.at(-1)
  check('第二条待办也通过真实门禁', candidate2?.strength === 'explicit', `strength=${candidate2?.strength}`)
  const trigger2 = buildTaskTrigger(task2, '2026-11-01T19:30:00.000Z')
  const decision2 = engine.decide(trigger2.id, { kind: 'accept', title: '写一行 CHANGELOG', scope: 'small', reason: '演练', name: 'changelog-line' })
  void decision2
  await flush()
  const ticket2Id = decision2.ticketId
  const ticket2 = repo.tickets.get(ticket2Id)
  engine.assignmentStarted(ticket2Id, ticket2.assignments.at(-1).id)
  engine.report(ticket2Id, { state: 'blocked', summary: '缺验收环境', question: null })
  const blockedView = projectTask({ task: task2, ticket: ticketView(repo.tickets.get(ticket2Id), ticketStage), submitted: true })
  check('blocked 报告 → 需要我/受阻', blockedView.lane === 'attention' && blockedView.substate === 'blocked', `${blockedView.lane}/${blockedView.substate}`)

  const retried = engine.retryTicket(ticket2Id)
  const retriedView = projectTask({ task: task2, ticket: ticketView(retried, ticketStage), submitted: true })
  check('retry 后 Ticket 重新打开', retried.ended === undefined)
  check('retry 后投影回到执行中/排队中', retriedView.lane === 'working' && retriedView.substate === 'queued', `${retriedView.lane}/${retriedView.substate}`)
  check('retry 生成新的 assignment', retried.assignments.length > 1, `assignments=${retried.assignments.length}`)
  const samePorts = await planTaskPorts(ports, { proposalId: task.proposalId, project: task.repo, taskId: task.id })
  check('retry 不改端口（换的是第二条待办，第一条的端口段保持不变）', JSON.stringify(samePorts) === JSON.stringify(task.ports), samePorts.join(','))

  const stopped = engine.stopTicket(ticket2Id, '演练：人工停止')
  check('stop 后 Ticket 以 stopped 结束', stopped.ended?.outcome === 'stopped', `outcome=${stopped.ended?.outcome}`)
  const stoppedView = projectTask({ task: task2, ticket: ticketView(repo.tickets.get(ticket2Id), ticketStage), submitted: true })
  check('面板投影 = 已完成/已停止', stoppedView.lane === 'done' && stoppedView.substate === 'stopped', `${stoppedView.lane}/${stoppedView.substate}`)

  section('G. 回收：worktree + 分支 + 端口')
  await git(directory, ['add', '.'])
  await git(directory, ['commit', '-q', '-m', 'docs: 演练改动'])
  // 先模拟人工把分支合回基线（真机里是 G5 的 merge 步骤）
  await git(repoRoot, ['merge', '-q', '--ff-only', `workmate/${name}`])
  currentTasks = [task]
  const portKey = `drill-proposal--demo--${task.id}`
  const beforePorts = await ports.get(portKey)
  const outcome = await reclaimOne(
    {
      worktreeRoots: async () => repoRoot,
      ports,
      // Ticket 已结束 → 允许回收
      ticketAlive: async () => false,
    },
    { task, directory, ticketId },
  )
  check('回收成功', outcome.removed === true, outcome.reason ?? '')
  check('目录已移除', !existsSync(directory))
  const afterList = (await git(repoRoot, ['worktree', 'list', '--porcelain']))
    .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9).trim())
  check('git worktree list 只剩主检出', afterList.length === 1, afterList.join(' | '))
  const branches = (await git(repoRoot, ['branch', '--format=%(refname:short)'])).split('\n').map((line) => line.trim()).filter(Boolean)
  check('分支已删除', !branches.includes(`workmate/${name}`), branches.join(','))
  check('端口已释放', outcome.portsReleased === true && beforePorts !== undefined && (await ports.get(portKey)) === undefined)

  section('汇总')
  notes.push(`  现场（失败的排查用）：${temp}`)

  if (options.keep !== true) await rm(temp, { recursive: true, force: true })
  return { notes, problems, temp, ticketId, directory, resultsFile }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help === true) {
      process.stdout.write('用法：node --experimental-transform-types scripts/verify-superagent-offline.mjs --superagent <path> [--keep]\n')
      process.exit(0)
    }
    const report = await drill(options)
    process.stdout.write(`${report.notes.join('\n')}\n`)
    if (report.problems.length > 0) {
      process.stderr.write(`\n失败 ${report.problems.length} 项：\n${report.problems.map((problem) => ` - ${problem}`).join('\n')}\n`)
      process.exit(1)
    }
    process.stdout.write('\n结论：全部通过。\n')
    process.exit(0)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}\n`)
    process.exit(2)
  }
}
