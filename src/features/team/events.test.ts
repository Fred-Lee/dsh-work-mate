import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../proposal/events.ts'
import { TeamEventLog } from './events.ts'
import { DEFAULT_TEAM_BUDGET, type TeamRun, type TeamTaskRecord } from './types.ts'

let home: string

const task: TeamTaskRecord = {
  id: 't1',
  title: 't1',
  role: 'backend-dev',
  project: 'repo',
  writes: [],
  dependsOn: [],
  acceptance: 'ok',
  status: 'dispatched',
  attempts: 1,
}
const run: TeamRun = {
  id: 'r1',
  proposalId: 'p1',
  template: 'bug-fix',
  status: 'running',
  tasks: [task],
  dispatches: [],
  budget: DEFAULT_TEAM_BUDGET,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-team-events-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('TeamEventLog', () => {
  it('appends dispatch/settled/run to the shared events.jsonl', async () => {
    const log = new EventLog({ homeRoot: home, subdir: 'workmate' })
    const sink = new TeamEventLog(log, () => new Date('2026-10-19T01:00:00.000Z'))

    await sink.dispatch({ run, task, dispatchId: 'd1' })
    await sink.settled({ run, task: { ...task, status: 'done' }, dispatchId: 'd1', status: 'done', detail: 'ok' })
    await sink.run({ run: { ...run, status: 'succeeded' }, detail: 'terminal:succeeded' })

    const { events } = await log.read()
    expect(events.map((event) => event.kind)).toEqual(['team-dispatch', 'team-settled', 'team-run'])
    expect(events[0]).toMatchObject({ proposalId: 'p1', runId: 'r1', taskId: 't1', dispatchId: 'd1', actor: 'agent' })
    expect(events[1]).toMatchObject({ status: 'done', detail: 'ok' })
    expect(events[2]).toMatchObject({ detail: 'terminal:succeeded' })
  })
})
