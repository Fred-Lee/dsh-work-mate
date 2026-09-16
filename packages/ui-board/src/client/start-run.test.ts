/**
 * 发起执行 pure heuristics (design D2/D3): the 按场景自适应 rule, the
 * "fastest installed" approximation and the prompt skeleton. No DOM, no fetch —
 * the whole point of the module is that the recommendation is local (0 token,
 * 0 network) and unit-testable on its own.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_CHOICES,
  AGENT_CHOICE_LABELS,
  classifyScenario,
  composePrompt,
  fastestInstalled,
  resolveAuto,
  resolveChoice,
} from './start-run'

describe('classifyScenario(卡片描述的本地关键词规则)', () => {
  it('拆解/计划类关键词 → decompose', () => {
    for (const text of ['拆解为 3 个子任务', '结算模块拆分', '先做一份计划', '设计查询接口的方案', 'step by step', 'write a plan']) {
      expect(classifyScenario(text), text).toBe('decompose')
    }
  })

  it('并行类关键词 → parallel', () => {
    for (const text of ['两个服务并行改造', '同时改 A 和 B', '各自独立完成', 'parallel execution']) {
      expect(classifyScenario(text), text).toBe('parallel')
    }
  })

  it('没有关键词 → simple', () => {
    expect(classifyScenario('给 utils 加注释')).toBe('simple')
    expect(classifyScenario('')).toBe('simple')
  })

  it('两类信号同时出现时以"拆解/计划"优先(判断:规划能力更稀缺,扇出本就是 orchestrator 的职责)', () => {
    expect(classifyScenario('拆解为 N 个子任务并行执行')).toBe('decompose')
  })
})

describe('fastestInstalled("最快已装"的可实现近似:claude → codex 偏好序)', () => {
  it('按文档化的偏好序取已装者', () => {
    expect(fastestInstalled(['claude', 'codex'])).toBe('claude')
    expect(fastestInstalled(['codex', 'claude'])).toBe('claude')
    expect(fastestInstalled(['codex'])).toBe('codex')
  })

  it('偏好序之外的 agent 也算已装(第一个),空列表才算没有', () => {
    expect(fastestInstalled(['pi'])).toBe('pi')
    expect(fastestInstalled(['pi', 'claude'])).toBe('claude')
    expect(fastestInstalled([])).toBeNull()
  })
})

describe('resolveAuto(按场景自适应)', () => {
  const both = ['claude', 'codex']

  it('拆解/计划型 → claude', () => {
    expect(resolveAuto('拆解为 3 个子任务', both)).toMatchObject({ scenario: 'decompose', agent: 'claude' })
    expect(resolveAuto('拆解为 3 个子任务', both).reason).toContain('claude')
  })

  it('并行独立型 → codex', () => {
    expect(resolveAuto('两个服务并行改造', both)).toMatchObject({ scenario: 'parallel', agent: 'codex' })
  })

  it('简单/单步 → 最快已装', () => {
    expect(resolveAuto('给 utils 加注释', both)).toMatchObject({ scenario: 'simple', agent: 'claude' })
    expect(resolveAuto('给 utils 加注释', ['codex'])).toMatchObject({ scenario: 'simple', agent: 'codex' })
  })

  it('首选未装 → 退回最快已装,并说明原因(自动档可以退,手动档不退)', () => {
    const decompose = resolveAuto('拆解为 3 个子任务', ['codex'])
    expect(decompose).toMatchObject({ scenario: 'decompose', agent: 'codex' })
    expect(decompose.reason).toContain('未安装')
    const parallel = resolveAuto('两个服务并行改造', ['claude'])
    expect(parallel).toMatchObject({ scenario: 'parallel', agent: 'claude' })
  })

  it('一个都没装 → 没有可提交的 agent(入口本身也会被 gate 关掉)', () => {
    const resolved = resolveAuto('给 utils 加注释', [])
    expect(resolved.agent).toBeNull()
    expect(resolved.reason).toContain('没有已安装的 agent')
  })
})

describe('resolveChoice(三档选择)', () => {
  const both = ['claude', 'codex']

  it('默认档 = 按场景自适应', () => {
    const resolved = resolveChoice('auto', '拆解为 3 个子任务', both)
    expect(resolved).toMatchObject({ agent: 'claude', scenario: 'decompose', overridden: false })
  })

  it('手动指定 claude/codex 一律原样使用,不回退到自适应', () => {
    const codex = resolveChoice('codex', '拆解为 3 个子任务', both)
    expect(codex).toMatchObject({ agent: 'codex', scenario: null, overridden: true })
    expect(codex.reason).toContain('不做自动回退')
    // 即使该 agent 没装,也不静默换成另一个(提交处会明确拒绝)
    expect(resolveChoice('claude', '给 utils 加注释', ['codex'])).toMatchObject({ agent: 'claude', overridden: true })
  })

  it('三档的文案:auto 是产品定的「按场景自适应(默认)」', () => {
    expect(AGENT_CHOICES).toEqual(['auto', 'claude', 'codex'])
    expect(AGENT_CHOICE_LABELS.auto).toBe('按场景自适应(默认)')
    expect(AGENT_CHOICE_LABELS.claude).toBe('claude')
    expect(AGENT_CHOICE_LABELS.codex).toBe('codex')
  })
})

describe('composePrompt(标题 + 摘要骨架)', () => {
  it('标题作标题行,摘要作骨架正文', () => {
    expect(composePrompt('实现检索', '为 A、B 设计查询接口')).toBe('实现检索\n\n为 A、B 设计查询接口')
  })

  it('缺摘要时只用标题;缺标题时只用摘要;都为空则为空', () => {
    expect(composePrompt('实现检索', '')).toBe('实现检索')
    expect(composePrompt('  ', '为 A、B 设计查询接口')).toBe('为 A、B 设计查询接口')
    expect(composePrompt('', '')).toBe('')
  })
})
