import { describe, expect, it } from 'vitest'
import { gradeUntaggedFindings } from './orchestrate.ts'

describe('review-severity grading (the archive gate node)', () => {
  it('asks the judgement layer per untagged finding and keeps only act-level answers', async () => {
    const asked: Array<{ node: string; options: string[] }> = []
    const decide = async (question: { node: string; options: string[] }, _signal?: AbortSignal) => {
      asked.push({ node: question.node, options: question.options })
      return { node: question.node, action: 'act', choice: 'HIGH', certainty: 1, provider: 'agent', threshold: 0.8 }
    }

    const graded = await gradeUntaggedFindings(
      { questions: ['并发写会不会丢数据？'], suggestions: ['补一个回归用例'] },
      decide as never,
      5,
    )

    expect(asked).toHaveLength(2)
    expect(asked.every((entry) => entry.node === 'review-severity')).toBe(true)
    expect(asked[0]?.options).toEqual(['CRIT', 'HIGH', 'MED', 'LOW'])
    expect(graded.map((finding) => finding.severity)).toEqual(['HIGH', 'HIGH'])
    expect(graded[0]?.tag).toBe('JUDGED-1')
  })

  it('drops findings when the judgement abstains (no invented severities)', async () => {
    const decide = async () => ({ node: 'review-severity', action: 'abstain', certainty: 0, provider: 'agent', threshold: 0.8 })

    const graded = await gradeUntaggedFindings({ questions: ['？'], suggestions: [] }, decide as never, 5)

    expect(graded).toEqual([])
  })

  it('respects the grading cap', async () => {
    const decide = async () => ({ node: 'review-severity', action: 'act', choice: 'LOW', certainty: 1, provider: 'agent', threshold: 0.8 })
    const graded = await gradeUntaggedFindings(
      { questions: ['a', 'b', 'c', 'd'], suggestions: [] },
      decide as never,
      2,
    )

    expect(graded).toHaveLength(2)
  })
})
