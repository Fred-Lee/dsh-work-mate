import { describe, expect, it } from 'vitest'
import {
  ASSOCIATION_TYPES,
  DEFAULT_WIP_LIMITS,
  GATE_GAP_KEYS,
  STAGES,
  SUMMARY_SOURCES,
  domainKey,
  domainOf,
  isAssociationType,
  isStage,
  isSummarySource,
  moduleOf,
  newItemId,
  nextStage,
  repoKey,
  sameJson,
  stageIndex,
  trimmed,
  wipLimit,
} from './model.ts'

describe('model: stage pipeline', () => {
  it('orders exactly four stages terminating at done', () => {
    expect(STAGES).toEqual(['requirements', 'spec', 'dev', 'done'])
    expect(STAGES.map(stageIndex)).toEqual([0, 1, 2, 3])
    expect(STAGES.map((stage) => nextStage(stage))).toEqual(['spec', 'dev', 'done', undefined])
  })

  it('guards stage values, rejecting display names and junk', () => {
    expect(isStage('dev')).toBe(true)
    expect(isStage('验收归档')).toBe(false)
    expect(isStage('DEV')).toBe(false)
    expect(isStage(2)).toBe(false)
    expect(isStage(undefined)).toBe(false)
  })

  it('guards association types and summary sources', () => {
    expect(ASSOCIATION_TYPES).toEqual(['doc', 'conversation', 'service', 'worktree', 'artifact', 'run'])
    expect(isAssociationType('conversation')).toBe(true)
    expect(isAssociationType('dsh')).toBe(false)
    expect(SUMMARY_SOURCES).toEqual(['model', 'manual', 'fallback'])
    expect(isSummarySource('manual')).toBe(true)
    expect(isSummarySource('llm')).toBe(false)
  })
})

describe('model: conflict domains', () => {
  it('keys a declared module as repo:module', () => {
    expect(domainKey({ baseRepo: 'R' }, { module: 'a' })).toBe('R:a')
    expect(domainOf({ repoScope: { baseRepo: 'R' }, scope: { module: 'a' } })).toBe('R:a')
  })

  it('falls back to repo:* when no module is declared', () => {
    expect(domainKey({ baseRepo: 'R' })).toBe('R:*')
    expect(domainKey({ baseRepo: 'R' }, {})).toBe('R:*')
    expect(domainKey({ baseRepo: 'R' }, { module: '   ' })).toBe('R:*')
    expect(moduleOf({ module: '  ' })).toBeUndefined()
  })

  it('never conflates different modules of the same repo', () => {
    expect(domainKey({ baseRepo: 'R' }, { module: 'a' })).not.toBe(domainKey({ baseRepo: 'R' }, { module: 'b' }))
  })

  it('falls back from baseRepo to projectGroup and marks a missing identity', () => {
    expect(repoKey({ baseRepo: 'R', projectGroup: 'G' })).toBe('R')
    expect(repoKey({ projectGroup: 'G' })).toBe('G')
    expect(repoKey({ projectGroup: '  G  ' })).toBe('G')
    expect(repoKey({})).toBe('')
    expect(domainKey({})).toBe('<unscoped>:*')
  })

  it('applies the module limit only to module domains', () => {
    expect(DEFAULT_WIP_LIMITS).toEqual({ module: 1, repo: 2 })
    expect(wipLimit({ module: 'a' }, DEFAULT_WIP_LIMITS)).toBe(1)
    expect(wipLimit(undefined, DEFAULT_WIP_LIMITS)).toBe(2)
    expect(wipLimit({ module: 'a' }, { module: 3, repo: 5 })).toBe(3)
    expect(wipLimit({}, { module: 3, repo: 5 })).toBe(5)
  })

  it('exposes the stable gap keys a UI can localize on', () => {
    expect(GATE_GAP_KEYS).toEqual({
      specFinalized: 'spec-finalized',
      runMerged: 'run-merged',
      auditOnRecord: 'audit-on-record',
      wipLimit: 'wip-limit',
      stageTransition: 'stage-transition',
    })
  })
})

describe('model: helpers', () => {
  it('generates unique url-safe ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newItemId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^wi_[0-9a-f]{16}$/)
  })

  it('trims text and compares values structurally', () => {
    expect(trimmed('  x ')).toBe('x')
    expect(trimmed('')).toBeUndefined()
    expect(trimmed(7)).toBeUndefined()
    expect(sameJson({ a: 1 }, { a: 1 })).toBe(true)
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameJson(undefined, undefined)).toBe(true)
  })
})
