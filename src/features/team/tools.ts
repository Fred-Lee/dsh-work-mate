/** Agent-facing team tools (change `autonomous-agent-team`, T2). */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import type { ProjectRegistry } from '../project/registry.ts'
import type { ProposalService } from '../proposal/service.ts'
import { validateProjectRoot } from '../proposal/openspec.ts'
import { planTeamWaves, parseTeamTasks, teamTasksPath } from './tasks.ts'
import { TeamCoordinator } from './coordinator.ts'
import { HostSubagentDispatcher, type SubagentServiceLike } from './host-dispatcher.ts'
import { effectiveTargets } from '../proposal/targets.ts'
import { isTeamTemplate, type TeamTemplate } from './types.ts'
import type { TeamRunner } from './runner.ts'
import { TeamEventLog } from './events.ts'
import { writeTeamSummary } from './summary.ts'
import type { EventLog } from '../proposal/events.ts'

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
}

const json = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
const asJson = (value: unknown): never => JSON.parse(JSON.stringify(value)) as never

export function registerTeamTools(ctx: Context, deps: TeamToolDeps): void {
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
      },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      async execute(args) {
        const proposal = await deps.proposals.get(args.proposalId)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.proposalId}`)
        const template = (args.template ?? 'requirement-full') as string
        if (!isTeamTemplate(template)) {
          throw new Error(`unknown template '${template}' — valid: requirement-full, bug-fix, research, delivery`)
        }
        const primary = proposal.primaryProject ?? proposal.projects[0]
        const registered = primary === undefined ? undefined : await deps.registry.get(primary)
        const root = (args.projectRoot ?? registered?.root ?? deps.projectRoot).trim()
        if (root === '') throw new Error('无可用项目根 — 先注册项目或在参数里给 projectRoot')
        const resolvedRoot = validateProjectRoot(root)
        const tasksPath = teamTasksPath(resolvedRoot, deps.openspecRoot, proposal.openspecChangeId)
        let raw: string
        try {
          raw = await readFile(tasksPath, 'utf8')
        } catch {
          throw new Error(`TASKS.json 不存在：${tasksPath} — 先由方案评估生成团队任务`)
        }
        const tasks = parseTeamTasks(raw)
        const run = await deps.runner.createRun({
          ...(args.id !== undefined ? { id: args.id } : {}),
          proposalId: proposal.id,
          template: template as TeamTemplate,
          tasks,
        })
        const waves = planTeamWaves(tasks, run.budget.maxParallel).map((wave) => wave.map((task) => task.id))
        return asJson({ run, waves })
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
      },
      output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
      timeoutMs: 30 * 60_000,
      async execute(args, exec) {
        const run = await deps.runner.get(args.runId)
        const subagents = deps.subagents()
        if (subagents === undefined) throw new Error('宿主未提供 subagents 服务 — 无法派发团队 worker')
        const agent = (exec as { agent?: unknown }).agent
        if (agent === undefined) throw new Error('团队派发需要当前 agent 作为父会话')
        const proposal = await deps.proposals.get(run.proposalId)
        if (proposal === undefined) throw new Error(`proposal not found: ${run.proposalId}`)
        const primary = proposal.primaryProject ?? proposal.projects[0]
        const registered = primary === undefined ? undefined : await deps.registry.get(primary)
        const root = (args.projectRoot ?? registered?.root ?? deps.projectRoot).trim()
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
        const dispatcher = new HostSubagentDispatcher(subagents, {
          parent: agent,
          cwdForTask,
          ...(args.provider !== undefined ? { provider: args.provider } : {}),
          signal: (exec as { signal?: AbortSignal }).signal ?? new AbortController().signal,
        })
        const result = await new TeamCoordinator(deps.runner, dispatcher, undefined, new TeamEventLog(deps.events)).run(
          args.runId,
        )
        const summaryPath = await writeTeamSummary({
          projectRoot: resolvedRoot,
          openspecRoot: deps.openspecRoot,
          changeId: proposal.openspecChangeId,
          run: result.run,
        })
        return asJson({ ...result, summaryPath })
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
