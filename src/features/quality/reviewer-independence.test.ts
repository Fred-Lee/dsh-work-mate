import { describe, expect, it } from 'vitest'
import { judgeReviewerIndependence, type Identity } from './reviewer-independence.ts'

const executors: Identity[] = [
  { name: 'fred', email: 'fred@example.com' },
  { name: 'deepseek-agent', email: 'agent@deepseek.local' },
]

describe('judgeReviewerIndependence', () => {
  it('accepts a reviewer nobody in the executor set claims', () => {
    const result = judgeReviewerIndependence({ reviewer: 'auditor@1.2', shadow: false, executors })
    expect(result.verdict).toBe('independent')
    expect(result.note).toContain('不在执行者身份集合内')
  })

  it('rejects the author reviewing their own work', () => {
    const result = judgeReviewerIndependence({ reviewer: 'fred', shadow: false, executors })
    expect(result.verdict).toBe('same-as-author')
    expect(result.matched?.name).toBe('fred')
  })

  it('matches on email and on the email local part', () => {
    expect(judgeReviewerIndependence({ reviewer: 'agent@deepseek.local', shadow: false, executors }).verdict).toBe('same-as-author')
    expect(judgeReviewerIndependence({ reviewer: 'agent', shadow: false, executors }).verdict).toBe('same-as-author')
  })

  it('is case-insensitive', () => {
    expect(judgeReviewerIndependence({ reviewer: 'FRED', shadow: false, executors }).verdict).toBe('same-as-author')
  })

  it('reports a missing signature instead of guessing a pass', () => {
    const result = judgeReviewerIndependence({ reviewer: undefined, shadow: false, executors })
    expect(result.verdict).toBe('missing')
    expect(result.note).toContain('未署名')
  })

  it('marks a shadow report without a name as missing but says shadow does not block', () => {
    const result = judgeReviewerIndependence({ reviewer: '', shadow: true, executors })
    expect(result.verdict).toBe('missing')
    expect(result.note).toContain('shadow')
  })

  it('returns undetermined when there are no executor facts and accuses nobody', () => {
    const result = judgeReviewerIndependence({ reviewer: 'someone', shadow: false, executors: [] })
    expect(result.verdict).toBe('undetermined')
    expect(result.matched).toBeUndefined()
    expect(result.note).toContain('无法判定')
  })

  it('stays conservative rather than accusing on a fuzzy name', () => {
    // `fred (workmate)` is *probably* the author, but a wrong `same-as-author` verdict
    // blocks an archive in `block` mode. Precision beats recall here.
    const result = judgeReviewerIndependence({ reviewer: 'fred (workmate)', shadow: false, executors })
    expect(result.verdict).toBe('independent')
  })
})
