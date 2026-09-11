import { describe, expect, it } from 'vitest'
import { ConfirmationGate, GateDeniedError } from './gate.ts'
import { allowAllPolicy } from './policy.ts'

function makeGate(ttlMs = 300_000, now?: () => number) {
  return new ConfirmationGate({ policy: { modeFor: () => 'confirm-required' as const, tokenTtlMs: () => ttlMs }, now })
}

describe('ConfirmationGate', () => {
  it('request → decide(approve) → consume grants exactly once in scope', () => {
    const gate = makeGate()
    const { approvalId } = gate.request('merge', 'merge:t-1', 'ui')
    const decided = gate.decide(approvalId, true)
    expect(decided.granted).toBe(true)
    if (!decided.granted) throw new Error('unreachable')
    const info = gate.consume('merge', 'merge:t-1', decided.token)
    expect(info.op).toBe('merge')
    expect(info.scope).toBe('merge:t-1')
    expect(info.source).toBe('ui')
  })

  it('a consumed token cannot be reused', () => {
    const gate = makeGate()
    const { approvalId } = gate.request('merge', 'merge:t-1')
    const decided = gate.decide(approvalId, true)
    if (!decided.granted) throw new Error('unreachable')
    gate.consume('merge', 'merge:t-1', decided.token)
    expect(() => gate.consume('merge', 'merge:t-1', decided.token)).toThrow(GateDeniedError)
  })

  it('a token bound to one scope cannot be spent on another (scope swap refused)', () => {
    const gate = makeGate()
    const { approvalId } = gate.request('merge', 'merge:t-1')
    const decided = gate.decide(approvalId, true)
    if (!decided.granted) throw new Error('unreachable')
    expect(() => gate.consume('merge', 'merge:t-2', decided.token)).toThrow(GateDeniedError)
    expect(() => gate.consume('discard', 'merge:t-1', decided.token)).toThrow(GateDeniedError)
  })

  it('expired tokens are refused (TTL honored)', () => {
    let now = 1_000_000
    const gate = makeGate(300_000, () => now)
    const { approvalId } = gate.request('merge', 'merge:t-1')
    const decided = gate.decide(approvalId, true)
    if (!decided.granted) throw new Error('unreachable')
    now += 300_001 // past TTL
    expect(() => gate.consume('merge', 'merge:t-1', decided.token)).toThrow(/expired/)
  })

  it('expired pending approvals are dropped from the pending list and decide()', () => {
    let now = 1_000_000
    const gate = makeGate(300_000, () => now)
    const { approvalId } = gate.request('discard', 'discard:t-1')
    now += 300_001
    expect(gate.listPending()).toHaveLength(0)
    expect(gate.decide(approvalId, true)).toEqual({ granted: false, reason: 'not-found' })
  })

  it('denying an approval closes it and grants nothing', () => {
    const gate = makeGate()
    const { approvalId } = gate.request('merge', 'merge:t-1')
    expect(gate.decide(approvalId, false)).toMatchObject({ granted: false, reason: 'denied', op: 'merge', scope: 'merge:t-1', source: 'ui' })
    expect(gate.listPending()).toHaveLength(0)
  })

  it('listPending returns pending requests newest first with scope/source', () => {
    let now = 1_000_000
    const gate = makeGate(300_000, () => now)
    gate.request('merge', 'merge:t-1', 'tool')
    now += 10
    gate.request('discard', 'discard:t-2', 'ui')
    const pending = gate.listPending()
    expect(pending).toHaveLength(2)
    expect(pending[0]!.op).toBe('discard')
    expect(pending[1]!.op).toBe('merge')
    expect(pending[1]!.source).toBe('tool')
    expect(pending[1]!.scope).toBe('merge:t-1')
  })

  it('approval ids are unique and tokens are 16-byte hex (32 chars)', () => {
    const gate = makeGate()
    const a = gate.request('merge', 's1')
    const b = gate.request('merge', 's2')
    expect(a.approvalId).not.toBe(b.approvalId)
    const decided = gate.decide(a.approvalId, true)
    if (!decided.granted) throw new Error('unreachable')
    expect(decided.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('does not consult the policy (the engine decides whether to gate)', () => {
    // auto-grant policy still issues a usable token when requested.
    const gate = new ConfirmationGate({ policy: allowAllPolicy })
    const { approvalId } = gate.request('cancel', 'cancel:t-1', 'tool')
    const decided = gate.decide(approvalId, true)
    expect(decided.granted).toBe(true)
  })

  it('unknown token consumption throws gate-denied with unknown-token', () => {
    const gate = makeGate()
    expect(() => gate.consume('merge', 'merge:t-1', 'deadbeef')).toThrow(/unknown-token/)
  })
})
