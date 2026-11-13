/**
 * 提案状态的证据增强（polish-workbench-delivery T3）：`## Why` 段解析。
 *
 * Why 是抽屉「做了什么」的开场证据，但它是**增强不是门禁**——解析不出
 * （历史 change 没有 `## Why`、段是空的）必须静默缺省，绝不新增失败路径。
 */
import { describe, expect, it } from 'vitest'
import { whyFromProposalMd } from './status.ts'

describe('whyFromProposalMd', () => {
  it('抽取 ## Why 到下一个 ## 之间并压成一段', () => {
    const content = [
      '# 提案：某变更',
      '',
      '## Why',
      '',
      '- 第一点',
      '- 第二点：带冒号',
      '',
      '## What Changes',
      '',
      '- 无关段',
    ].join('\n')
    expect(whyFromProposalMd(content)).toBe('第一点 第二点：带冒号')
  })

  it('Why 段到文件尾也成立', () => {
    expect(whyFromProposalMd('## Why\n只有一段')).toBe('只有一段')
  })

  it('没有 Why 段 → undefined（历史 change）', () => {
    expect(whyFromProposalMd('# 提案\n\n## What Changes\n- x')).toBeUndefined()
  })

  it('Why 段为空 → undefined，不是空串', () => {
    expect(whyFromProposalMd('## Why\n\n## What Changes\n- x')).toBeUndefined()
  })
})
