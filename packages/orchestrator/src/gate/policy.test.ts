import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_POLICY,
  DEFAULT_POLICY_MODES,
  DEFAULT_TOKEN_TTL_SEC,
  FilePolicy,
  allowAllPolicy,
  confirmAllPolicy,
  defaultPolicyPath,
  loadPolicyFileSync,
  normalizePolicyFile,
} from './policy.ts'

describe('policy defaults', () => {
  it('keeps merge/discard/worktree-cleanup/topology-delete confirm-required and cancel auto-grant', () => {
    expect(DEFAULT_POLICY_MODES.merge).toBe('confirm-required')
    expect(DEFAULT_POLICY_MODES.discard).toBe('confirm-required')
    expect(DEFAULT_POLICY_MODES['worktree-cleanup']).toBe('confirm-required')
    expect(DEFAULT_POLICY_MODES['topology-delete']).toBe('confirm-required')
    expect(DEFAULT_POLICY_MODES.cancel).toBe('auto-grant')
    expect(DEFAULT_POLICY.tokenTtlSec).toBe(DEFAULT_TOKEN_TTL_SEC)
  })

  it('defaultPolicyPath is HELMSMAN_HOME aware', () => {
    const prev = process.env.HELMSMAN_HOME
    try {
      process.env.HELMSMAN_HOME = '/tmp/hh'
      expect(defaultPolicyPath()).toBe('/tmp/hh/policy.json')
    } finally {
      if (prev === undefined) delete process.env.HELMSMAN_HOME
      else process.env.HELMSMAN_HOME = prev
    }
  })
})

describe('normalizePolicyFile', () => {
  it('fills defaults for missing operations', () => {
    const file = normalizePolicyFile({ operations: {} })
    expect(file.operations).toEqual(DEFAULT_POLICY_MODES)
    expect(file.tokenTtlSec).toBe(DEFAULT_TOKEN_TTL_SEC)
  })

  it('accepts a partial override and keeps the rest', () => {
    const file = normalizePolicyFile({ operations: { discard: 'auto-grant' }, tokenTtlSec: 60 })
    expect(file.operations.discard).toBe('auto-grant')
    expect(file.operations.merge).toBe('confirm-required')
    expect(file.tokenTtlSec).toBe(60)
  })

  it('rejects an unknown operation key (fail-closed, no silent widening)', () => {
    expect(() => normalizePolicyFile({ operations: { delet: 'auto-grant' } })).toThrow(/unknown operation/)
  })

  it('rejects an unknown top-level key', () => {
    expect(() => normalizePolicyFile({ operations: {}, ttl: 5 })).toThrow(/unknown key/)
  })

  it('rejects an invalid mode value', () => {
    expect(() => normalizePolicyFile({ operations: { merge: 'maybe' } })).toThrow(/invalid policy mode/)
  })

  it('rejects a non-positive tokenTtlSec', () => {
    expect(() => normalizePolicyFile({ operations: {}, tokenTtlSec: 0 })).toThrow(/tokenTtlSec/)
    expect(() => normalizePolicyFile({ operations: {}, tokenTtlSec: -1 })).toThrow(/tokenTtlSec/)
  })
})

describe('loadPolicyFileSync', () => {
  it('uses defaults when no file exists', () => {
    const policy = loadPolicyFileSync('/nonexistent/policy.json')
    expect(policy.modeFor('merge')).toBe('confirm-required')
    expect(policy.modeFor('cancel')).toBe('auto-grant')
    expect(policy.tokenTtlMs()).toBe(300_000)
  })

  it('round-trips a written policy file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policy-'))
    const path = join(dir, 'policy.json')
    await writeFile(path, JSON.stringify({ operations: { merge: 'auto-grant', cancel: 'confirm-required' }, tokenTtlSec: 60 }), 'utf8')
    const policy = loadPolicyFileSync(path)
    expect(policy.modeFor('merge')).toBe('auto-grant')
    expect(policy.modeFor('discard')).toBe('confirm-required')
    expect(policy.modeFor('cancel')).toBe('confirm-required')
    expect(policy.tokenTtlMs()).toBe(60_000)
  })

  it('corrupt file falls back to defaults without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policy-'))
    const path = join(dir, 'policy.json')
    await writeFile(path, '{not json', 'utf8')
    const policy = loadPolicyFileSync(path)
    expect(policy.modeFor('merge')).toBe('confirm-required')
  })
})

describe('test seams', () => {
  it('allowAllPolicy auto-grants every operation', () => {
    for (const op of ['merge', 'discard', 'cancel', 'worktree-cleanup', 'topology-delete'] as const) {
      expect(allowAllPolicy.modeFor(op)).toBe('auto-grant')
    }
  })
  it('confirmAllPolicy requires confirmation for every operation', () => {
    expect(confirmAllPolicy.modeFor('merge')).toBe('confirm-required')
    expect(confirmAllPolicy.tokenTtlMs()).toBe(300_000)
  })
  it('FilePolicy exposes tokenTtlSec*1000', () => {
    const p = new FilePolicy(DEFAULT_POLICY)
    expect(p.tokenTtlMs()).toBe(300_000)
  })
})
