/** Agent-facing team tools (change `autonomous-agent-team`, T2). */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectRegistry } from '../project/registry.ts'
import type { ProposalService } from '../proposal/service.ts'
import { validateProjectRoot } from '../proposal/openspec.ts'
import { planTeamWaves, parseTeamTasks, teamTasksPath } from './tasks.ts'
import { checkTeamCompleteness, validateOpenSpecChange } from './completeness.ts'
import { prepareTeamArtifacts } from './prepare.ts'
import { TeamCoordinator } from './coordinator.ts'
import { HostSubagentDispatcher, type SubagentServiceLike } from './host-dispatcher.ts'
import { effectiveTargets } from '../proposal/targets.ts'
import { isTeamTemplate, type TeamTemplate } from './types.ts'
import type { TeamRunner } from './runner.ts'
import { TeamEventLog } from './events.ts'
import { writeTeamSummary } from './summary.ts'
import type { EventLog } from '../proposal/events.ts'
import { assertRolePresets, presetForRole, type RolePresetConfig } from './presets.ts'
import { parseRoleModels } from './models.ts'

export interface TeamToolDeps {
  proposals: ProposalService
  registry: ProjectRegistry
  runner: TeamRunner
  openspecRoot: string
  /** Config-level default project root; may be empty. */
  projectRoot: string
  /** Optional host subagent service; absent means no autonomous dispatch. */
  subagents: () => SubagentServiceLike | undefined
  /** Trunk used when projecting legacy single-target branches. */
  lifecycleMainBranch: string
  /** Append-only proposal event log (team events share it). */
  events: EventLog
  /** Role→agentPreset mapping (T3-3.6). */
  rolePresetConfig: RolePresetConfig
  requireRolePresets: boolean
  /** Raw JSON role→model map (Config.teamRoleModels). */
  roleModels: string
}

const json = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
const asJson = (value: unknown): never => JSON.parse(JSON.stringify(value)) as never

export function registerTeamTools(ctx: Context, deps: TeamToolDeps): void {
  const startRun = async (
    exec: { agent?: unknown; signal?: AbortSignal },
    runId: string,
    options: { provider?: string; projectRoot?: string; maxWaves?: number } = {},
  ): Promise<unknown> => {
    const run = await deps.runner.get(runId)
    const subagents = deps.subagents()
    if (subagents === undefined) throw new Error('宿主未提供 subagents 服务 — 无法派发团队 worker')
    const agent = exec.agent
    if (agent === undefined) throw new Error('团队派发需要当前 agent 作为父会话')
    const proposal = await deps.proposals.get(run.proposalId)
    if (proposal === undefined) throw new Error(`proposal not found: ${run.proposalId}`)
    if (proposal.status !== 'implementing' && proposal.status !== 'merging') {
      throw new Error(
        `提案当前为 ${proposal.status}，团队派发前必须先到 implementing（G2 已批准、target worktree 已创建）`,
      )
    }
    const primary = proposal.primaryProject ?? proposal.projects[0]
    const registered = primary === undefined ? undefined : await deps.registry.get(primary)
    const root = (options.projectRoot ?? registered?.root ?? deps.projectRoot).trim()
    if (root === '') throw new Error('无可用项目根 — 先注册项目或在参数里给 projectRoot')
    const resolvedRoot = validateProjectRoot(root)
    const targets = effectiveTargets(proposal, deps.lifecycleMainBranch)
    const cwdForTask = (task: { project: string; id: string }): string => {
      const target = targets.find((entry) => entry.project === task.project)
      if (target?.worktreePath === undefined) {
        throw new Error(`target ${task.project} 没有 worktree — 先推进提案到 implementing`)
      }
      return target.worktreePath
    }
    const roleModels = parseRoleModels(deps.roleModels)
    if (roleModels.errors.length > 0) {
      throw new Error(`teamRoleModels 配置非法 — ${roleModels.errors.join('；')}`)
    }
    const missingPresets = assertRolePresets({
      tasks: run.tasks,
      config: deps.rolePresetConfig,
      required: deps.requireRolePresets,
    })
    if (missingPresets.length > 0) {
      throw new Error(`角色权限 preset 未配置 — ${missingPresets.join('；')}。配置 teamReadonlyPreset/teamWorkspacePreset`)
    }
    const dispatcher = new HostSubagentDispatcher(subagents, {
      parent: agent,
      cwdForTask,
      agentPresetForRole: (role) => presetForRole(role, deps.rolePresetConfig),
      agentOptionsForRole: (role) => roleModels.models[role],
      artifactDirForTask: () => join(deps.openspecRoot, 'changes', proposal.openspecChangeId),
      verifyReportPath: true,
      requireCommit: true,
      baseForTask: (task) => targets.find((entry) => entry.project === task.project)?.baseCommit,
      measureChanges: true,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      signal: exec.signal ?? new AbortController().signal,
    })
    const result = await new TeamCoordinator(
      deps.runner,
      dispatcher,
      undefined,
      new TeamEventLog(deps.events),
    ).run(runId, options.maxWaves !== undefined ? { maxWaves: options.maxWaves } : {})
    const summaryPath = await writeTeamSummary({
      projectRoot: resolvedRoot,
      openspecRoot: deps.openspecRoot,
      changeId: proposal.openspecChangeId,
      run: result.run,
    })
    return { ...result, summaryPath }
  }

  ctx.tools.register(
    defineTool({
      name: 'workmate_team_plan',
      description:
        'Create a team Run from the proposal’s TASKS.json and return the dependency waves. Does not dispatch workers; use workmate_team_status to inspect progress.',
      parameters: {
        proposalId: { type: 'string', required: true, description: 'Proposal whose TASKS.json defines the work.' },
        template: {
          type: 'string',
          description: 'Team template: requirement-full | bug-fix | research | delivery. Default requirement-full.',
        },
        id: { type: 'string', description: 'Optional run id (generated when omitted).' },
        projectRoot: { type: 'string', description: 'Root hosting the OpenSpec change; defaults to the primary project.' },
        start: { type: 'boolean', description: 'Create then dispatch the first wave immediately (requires host agent).' },
        maxWaves: { type: 'number', description: 'Wave cap when start=true; default 1.' },
        entry: { type: 'string', description: 'Entry gate override: G2 (artifacts ready) or G0 (start from requirement evaluation).' },
        entryReason: { type: 'string', description: 'Required when overriding the entry gate; recorded in the response.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      timeoutMs: 30 * 60_000,
      async execute(args, exec) {
        const proposal = await deps.proposals.get(args.proposalId)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.proposalId}`)
        if (!['ready', 'implementing', 'merging'].includes(proposal.status)) {
          throw new Error(
            `提案当前为 ${proposal.status} — 团队 Run 只能在 ready/implementing/merging 创建（archiving 后不允许新建 Run）`,
          )
        }
        const template = (args.template ?? 'requirement-full') as string
        if (!isTeamTemplate(template)) {
          throw new Error(`unknown template '${template}' — valid: requirement-full, bug-fix, research, delivery`)
        }
        const primary = proposal.primaryProject ?? proposal.projects[0]
        const registered = primary === undefined ? undefined : await deps.registry.get(primary)
        const root = (args.projectRoot ?? registered?.root ?? deps.projectRoot).trim()
        if (root === '') throw new Error('无可用项目根 — 先注册项目或在参数里给 projectRoot')
        const resolvedRoot = validateProjectRoot(root)
        const entryOverride = args.entry === 'G0' ? 'G0' : args.entry === 'G2' ? 'G2' : undefined
        if (entryOverride === 'G0') {
          return asJson({
            entry: { gate: 'G0', reason: args.entryReason ?? '调用方要求从需求评估开始', overridden: true },
            proposalId: proposal.id,
            next: '先用 requirement-evaluator 产出 REQ/PLAN/TASKS，再重新调用 workmate_team_plan',
          })
        }
        const completeness = await checkTeamCompleteness(
          resolvedRoot,
          deps.openspecRoot,
          proposal.openspecChangeId,
          template as TeamTemplate,
        )
        if (!completeness.ok) {
          throw new Error(`团队工件不完整（G1）— ${completeness.errors.join('；')}`)
        }
        const validation = await validateOpenSpecChange(resolvedRoot, proposal.openspecChangeId)
        if (validation?.ok === false) {
          throw new Error(`openspec validate 失败，入口判为 G0 — ${validation.detail ?? ''}`)
        }
        const tasksPath = teamTasksPath(resolvedRoot, deps.openspecRoot, proposal.openspecChangeId)
        let raw: string
        try {
          raw = await readFile(tasksPath, 'utf8')
        } catch {
          throw new Error(`TASKS.json 不存在：${tasksPath} — 先运行 workmate_team_prepare 从 tasks.md 派生，或手工生成`)
        }
        const tasks = parseTeamTasks(raw)
        // Workers read/report artifacts from the target worktree. The change
        // directory must therefore exist in the base commit BEFORE the run;
        // untracked artifacts in the main checkout are invisible there.
        for (const target of effectiveTargets(proposal, deps.lifecycleMainBranch)) {
          if (target.worktreePath === undefined) continue
          try {
            await access(join(target.worktreePath, deps.openspecRoot, 'changes', proposal.openspecChangeId, 'TASKS.json'))
          } catch {
            throw new Error(
              `target ${target.project} 的 worktree 缺 ${deps.openspecRoot}/changes/${proposal.openspecChangeId}/TASKS.json — 先把 OpenSpec 工件提交到基线分支再进入 implementing`,
            )
          }
        }
        const run = await deps.runner.createRun({
          ...(args.id !== undefined ? { id: args.id } : {}),
          proposalId: proposal.id,
          template: template as TeamTemplate,
          tasks,
        })
        const waves = planTeamWaves(tasks, run.budget.maxParallel).map((wave) => wave.map((task) => task.id))
        if (args.start !== true) {
          return asJson({ entry: { gate: 'G2', reason: entryOverride === 'G2' ? (args.entryReason ?? '调用方指定 G2') : '工件完整，直接进入方案确认' }, run, waves })
        }
        const started = await startRun(exec, run.id, {
          ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
          maxWaves: args.maxWaves ?? 1,
        })
        return asJson({ entry: { gate: 'G2', reason: '工件完整，直接进入方案确认' }, run, waves, started })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_team_prepare',
      description:
        'Derive missing team authoring artifacts (REQ.md/PLAN.md/TASKS.json) from an existing OpenSpec proposal without overwriting. Evidence files are never generated.',
      parameters: {
        proposalId: { type: 'string', required: true, description: 'Proposal whose OpenSpec change should be normalized.' },
        projectRoot: { type: 'string', description: 'Root hosting the OpenSpec change; defaults to the primary project.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      async execute(args) {
        const proposal = await deps.proposals.get(args.proposalId)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.proposalId}`)
        const primary = proposal.primaryProject ?? proposal.projects[0]
        const registered = primary === undefined ? undefined : await deps.registry.get(primary)
        const root = (args.projectRoot ?? registered?.root ?? deps.projectRoot).trim()
        if (root === '') throw new Error('无可用项目根 — 先注册项目或在参数里给 projectRoot')
        const resolvedRoot = validateProjectRoot(root)
        return asJson(
          await prepareTeamArtifacts({
            projectRoot: resolvedRoot,
            openspecRoot: deps.openspecRoot,
            changeId: proposal.openspecChangeId,
            primaryProject: primary ?? proposal.projects[0] ?? '',
            ...(proposal.targets !== undefined ? { targets: proposal.targets } : {}),
          }),
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_team_run',
      description:
        'Drive a planned team Run to a terminal status: one native subagent per task, cwd bound to the target worktree, wave by wave. Requires the host subagents service.',
      parameters: {
        runId: { type: 'string', required: true, description: 'Run id returned by workmate_team_plan.' },
        provider: { type: 'string', description: 'Subagent provider name (default: spawn).' },
        projectRoot: { type: 'string', description: 'Root hosting the OpenSpec change; defaults to the primary project.' },
        maxWaves: { type: 'number', description: 'Stop after N waves and leave the run resumable (first-wave dispatch).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      timeoutMs: 30 * 60_000,
      async execute(args, exec) {
        return asJson(
          await startRun(exec, args.runId, {
            ...(args.provider !== undefined ? { provider: args.provider } : {}),
            ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
            ...(args.maxWaves !== undefined ? { maxWaves: args.maxWaves } : {}),
          }),
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_team_inbox',
      description: 'List inbox messages (questions/escalations/worker_done) for one team Run.',
      parameters: { runId: { type: 'string', required: true, description: 'Team Run id.' } },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      isConcurrencySafe: () => true,
      async execute(args) {
        const run = await deps.runner.get(args.runId)
        return asJson({ messages: run.inbox ?? [] })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_team_answer',
      description: 'Answer a paused team question/escalation and requeue its blocked task; run workmate_team_run again to continue.',
      parameters: {
        runId: { type: 'string', required: true, description: 'Team Run id.' },
        messageId: { type: 'string', required: true, description: 'Inbox message id.' },
        reply: { type: 'string', required: true, description: 'The decision/answer given to the worker.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      async execute(args) {
        const answered = await deps.runner.answerMessage(args.runId, args.messageId, args.reply)
        return asJson(answered)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_team_status',
      description: 'Read one team Run and the tasks that may be dispatched next.',
      parameters: { runId: { type: 'string', required: true, description: 'Run id returned by workmate_team_plan.' } },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      isConcurrencySafe: () => true,
      async execute(args) {
        const run = await deps.runner.get(args.runId)
        const nextWave = await deps.runner.nextWave(args.runId)
        return asJson({ run, nextWave: nextWave.map((task) => task.id) })
      },
    }),
  )
}
