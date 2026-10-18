/**
 * Team event sink (change `autonomous-agent-team`, T4-4.4). Dispatch, settle
 * and run-terminal facts go into the same append-only `events.jsonl` as the
 * proposal lifecycle, so the panel can replay who was asked to do what.
 */
import type { EventLog } from '../proposal/events.ts'
import type { TeamRun, TeamTaskRecord } from './types.ts'

export interface TeamEventInput {
  run: TeamRun
  task: TeamTaskRecord
  dispatchId: string
  status?: string
  detail?: string
}

export interface TeamRunEventInput {
  run: TeamRun
  detail?: string
}

export interface TeamEventSink {
  dispatch(input: TeamEventInput): Promise<void>
  settled(input: TeamEventInput): Promise<void>
  run(input: TeamRunEventInput): Promise<void>
}

export class TeamEventLog implements TeamEventSink {
  constructor(
    private readonly events: EventLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async record(
    kind: 'team-dispatch' | 'team-settled' | 'team-run',
    input: TeamEventInput | TeamRunEventInput,
  ): Promise<void> {
    const run = input.run
    const task = 'task' in input ? input.task : undefined
    await this.events.append({
      at: this.now().toISOString(),
      proposalId: run.proposalId,
      kind,
      actor: 'agent',
      runId: run.id,
      ...(task !== undefined ? { taskId: task.id } : {}),
      ...('dispatchId' in input ? { dispatchId: input.dispatchId } : {}),
      ...('status' in input && input.status !== undefined ? { status: input.status } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    })
  }

  async dispatch(input: TeamEventInput): Promise<void> {
    await this.record('team-dispatch', {
      ...input,
      detail: input.detail ?? `role=${input.task.role} attempt=${input.task.attempts}`,
    })
  }

  async settled(input: TeamEventInput): Promise<void> {
    await this.record('team-settled', input)
  }

  async run(input: TeamRunEventInput): Promise<void> {
    await this.record('team-run', input)
  }
}
