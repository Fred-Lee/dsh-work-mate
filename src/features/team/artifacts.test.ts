import { describe, expect, it } from 'vitest'
import { isTeamArtifact, renderTeamArtifact, REQUIRED_SECTIONS } from './artifacts.ts'
import { TEAM_ARTIFACTS } from './types.ts'

describe('team artifacts', () => {
  it('declares all six artifacts with required sections', () => {
    expect(TEAM_ARTIFACTS).toHaveLength(6)
    for (const artifact of TEAM_ARTIFACTS) {
      expect(isTeamArtifact(artifact)).toBe(true)
      expect(REQUIRED_SECTIONS[artifact]).toBeDefined()
    }
    expect(REQUIRED_SECTIONS['REQ.md']).toContain('## 边界与禁止项')
    expect(REQUIRED_SECTIONS['TEAM-REVIEW.md']).toContain('## CRITICAL 问题')
  })

  it('renders markdown skeletons with a run id', () => {
    const rendered = renderTeamArtifact('REQ.md', '示例提案', 'run-1')
    expect(rendered).toContain('# REQ — 示例提案')
    expect(rendered).toContain('> Run: run-1')
    expect(rendered).toContain('## 边界与禁止项')
    expect(rendered).toContain('<!-- 待填写 -->')
  })

  it('renders a parseable TASKS.json sample', () => {
    const parsed = JSON.parse(renderTeamArtifact('TASKS.json', '示例', 'run-1')) as {
      tasks: Array<{ id: string; role: string }>
    }
    expect(parsed.tasks[0]?.id).toBe('t1')
    expect(parsed.tasks[0]?.role).toBe('backend-dev')
  })
})
