import { describe, expect, it } from 'vitest'
import { buildTaskPrompt, ROLE_PROMPTS } from './index.ts'
import { TEAM_ROLES } from '../types.ts'

describe('role prompts', () => {
  it('defines every role with responsibilities and rules', () => {
    for (const role of TEAM_ROLES) {
      const prompt = ROLE_PROMPTS[role]
      expect(prompt.role).toBe(role)
      expect(prompt.headline.length).toBeGreaterThan(0)
      expect(prompt.responsibilities.length).toBeGreaterThan(0)
      expect(prompt.rules.length).toBeGreaterThan(0)
    }
  })

  it('keeps read-only roles explicit about not changing code', () => {
    expect(ROLE_PROMPTS['requirement-evaluator'].rules.join()).toContain('不写代码')
    expect(ROLE_PROMPTS['solution-evaluator'].rules.join()).toContain('不写实现')
    expect(ROLE_PROMPTS.reviewer.rules.join()).toContain('不审自己写的实现')
    expect(ROLE_PROMPTS['integration-tester'].rules.join()).toContain('不改生产源码')
  })

  it('builds a task prompt with scope, acceptance and role artifacts', () => {
    const prompt = buildTaskPrompt({
      task: {
        id: 't1',
        title: '实现订单详情',
        role: 'backend-dev',
        project: 'repo',
        writes: ['src/main/order/**'],
        acceptance: '接口 200 且单测通过',
      },
      runId: 'r1',
      proposalId: 'p1',
    })
    expect(prompt).toContain('实现订单详情')
    expect(prompt).toContain('src/main/order/**')
    expect(prompt).toContain('接口 200 且单测通过')
    expect(prompt).toContain('Run：r1')
    expect(prompt).toContain('不要启动子代理')
  })

  it('uses the role contract to name owned artifacts', () => {
    const prompt = buildTaskPrompt({
      task: {
        id: 't2',
        title: '测试订单',
        role: 'integration-tester',
        project: 'repo',
        writes: ['tests/**'],
        acceptance: 'E2E 通过',
      },
    })
    expect(prompt).toContain('负责工件：TEST.md')
  })
  it('gives a reviewer the dispatch id needed for the TEAM-REVIEW marker', () => {
    const prompt = buildTaskPrompt({
      task: {
        id: 't3',
        title: '审查订单',
        role: 'reviewer',
        project: 'repo',
        writes: [],
        acceptance: '给出审查结论',
      },
      runId: 'r1',
      dispatchId: 'r1-t3-a1',
    })
    expect(prompt).toContain('Dispatch：r1-t3-a1')
    expect(prompt).toContain('<!-- reviewer: r1-t3-a1 -->')
  })

})
