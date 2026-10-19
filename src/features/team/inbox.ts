/**
 * Team inbox and positive-proof rules (change `autonomous-agent-team`, T2-2.4).
 *
 * A worker's `done` is accepted only with evidence: a result summary, or a
 * report for roles that own an artifact (TEST.md / TEAM-REVIEW.md). Questions and
 * escalations stay open until a human/coordinator answers them; no silent
 * auto-close.
 */
import { scopesIntersect } from '../swarm/plan.ts'
import { testScopeViolations } from '../quality/test-scope.ts'
import type { SettleInput } from './runner.ts'
import type { TeamRole, TeamTaskRecord } from './types.ts'

import type { InboxKind, InboxMessage } from './types.ts'

export type { InboxKind, InboxMessage } from './types.ts'

export interface PostInboxInput {
  runId: string
  kind: InboxKind
  body: string
  taskId?: string
}

export interface WorkerDoneInput {
  status: SettleInput['status']
  outcome?: string
  reportPath?: string
  /** Files the worker says it changed; when absent the check is unmeasured. */
  filesModified?: string[]
}

/** Positive proof required for `done`; empty array means accepted. */
export function validateWorkerDone(
  task: Pick<TeamTaskRecord, 'id' | 'role' | 'writes'>,
  input: WorkerDoneInput,
): string[] {
  if (input.status !== 'done') return []
  const errors: string[] = []
  const hasSummary = input.outcome !== undefined && input.outcome.trim() !== ''
  const hasReport = input.reportPath !== undefined && input.reportPath.trim() !== ''
  if (!hasSummary && !hasReport) errors.push(`${task.id} 声称 done 但没有结果说明或报告`)
  if ((task.role === 'integration-tester' || task.role === 'reviewer') && !hasReport) {
    errors.push(`${task.id}（${task.role}）done 必须提供 reportPath（TEST.md/TEAM-REVIEW.md）`)
  }
  if (input.filesModified !== undefined && input.filesModified.length > 0) {
    if (task.writes.length === 0) {
      errors.push(`${task.id} 改了文件但未声明写域 — 无法机检 (${input.filesModified.join(', ')})`)
    } else {
      const outside = input.filesModified.filter(
        (file) => !task.writes.some((scope) => scopesIntersect(scope, file)),
      )
      if (outside.length > 0) errors.push(`${task.id} 越界改文件：${outside.join(', ')}`)
    }
    if (task.role === 'integration-tester') {
      // The report artifact is evidence, not production code: a tester may write
      // TEST.md under the change dir even though it is outside tests/**.
      const candidates = input.filesModified.filter((file) => file !== input.reportPath)
      const testViolations = testScopeViolations(candidates)
      if (testViolations.length > 0) {
        errors.push(`${task.id} 测试改动越界（允许 tests/**、**/*.test.ts、scripts/**）：${testViolations.join(', ')}`)
      }
    }
  }
  return errors
}

export class TeamInbox {
  private messages: InboxMessage[] = []
  private counter = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  post(input: PostInboxInput): InboxMessage {
    if (input.body.trim() === '') throw new Error('inbox message body must not be empty')
    if (input.kind === 'worker_done' && (input.taskId === undefined || input.taskId.trim() === '')) {
      throw new Error('worker_done requires taskId')
    }
    this.counter += 1
    const message: InboxMessage = {
      id: `msg-${this.counter}`,
      runId: input.runId,
      kind: input.kind,
      body: input.body,
      at: this.now().toISOString(),
      status: 'open',
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    }
    this.messages.push(message)
    return message
  }

  all(runId: string): InboxMessage[] {
    return this.messages.filter((message) => message.runId === runId)
  }

  open(runId: string): InboxMessage[] {
    return this.all(runId).filter((message) => message.status === 'open')
  }

  /** Oldest open question/escalation, i.e. the next thing a coordinator must handle. */
  take(runId: string): InboxMessage | undefined {
    return this.open(runId).find((message) => message.kind === 'question' || message.kind === 'escalation')
  }

  hasBlocking(runId: string): boolean {
    return this.take(runId) !== undefined
  }

  answer(id: string, reply: string): InboxMessage {
    if (reply.trim() === '') throw new Error('answer must not be empty')
    const message = this.mustGet(id)
    if (message.kind !== 'question' && message.kind !== 'escalation') {
      throw new Error(`message ${id} is ${message.kind}, not a question/escalation`)
    }
    if (message.status !== 'open') throw new Error(`message ${id} is already ${message.status}`)
    message.status = 'answered'
    message.reply = reply
    message.replyAt = this.now().toISOString()
    return message
  }

  ack(id: string): InboxMessage {
    const message = this.mustGet(id)
    if (message.status !== 'answered' && message.status !== 'open') {
      throw new Error(`message ${id} is ${message.status}`)
    }
    message.status = 'acked'
    return message
  }

  private mustGet(id: string): InboxMessage {
    const message = this.messages.find((entry) => entry.id === id)
    if (message === undefined) throw new Error(`inbox message not found: ${id}`)
    return message
  }
}

/** Roles whose completion must carry an artifact path, not only prose. */
export const REPORT_ROLES: readonly TeamRole[] = ['integration-tester', 'reviewer']
