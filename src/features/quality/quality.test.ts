import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseReviewMd, unresolvedCriticals } from './review-parser.ts'
import { syncProjectAssets } from './sync.ts'

const REPO_ASSETS = resolve('assets/quality')

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'wm-quality-'))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

describe('parseReviewMd', () => {
  it('parses the four sections and CRITICAL resolution state', () => {
    const report = parseReviewMd(`# Review\n\n## 确认项\n\n- [x] 确认：需求映射完整\n\n## 疑问项\n\n- 疑问（BLOCKING）：字段语义\n\n## 建议补充项\n\n- 建议：补回滚步骤\n\n## CRITICAL 问题\n\n- [ ] CRIT-1 消费方遗漏\n- [x] CRIT-2 回滚缺失\n`)
    expect(report.confirms).toEqual(['确认：需求映射完整'])
    expect(report.questions).toEqual(['疑问（BLOCKING）：字段语义'])
    expect(report.suggestions).toEqual(['建议：补回滚步骤'])
    expect(report.criticals).toEqual([
      { text: 'CRIT-1 消费方遗漏', resolved: false },
      { text: 'CRIT-2 回滚缺失', resolved: true },
    ])
    expect(unresolvedCriticals(report)).toHaveLength(1)
  })

  it('missing sections parse as empty arrays', () => {
    expect(parseReviewMd('')).toEqual({ confirms: [], questions: [], suggestions: [], criticals: [] })
  })
})

describe('syncProjectAssets', () => {
  it('writes all assets into a fresh project, then skips on re-run', async () => {
    const first = await syncProjectAssets(project, { assetsDir: REPO_ASSETS })
    expect(first.written.length).toBeGreaterThanOrEqual(11)
    expect(first.written).toContain('openspec/config.yaml')
    expect(first.written).toContain('.claude/agents/proposal-auditor.md')

    const second = await syncProjectAssets(project, { assetsDir: REPO_ASSETS })
    expect(second.written).toEqual([])
    expect(second.skipped.length).toBe(first.written.length)
  })

  it('never overwrites a user-edited file and merges hooks without duplicates', async () => {
    const rulesPath = join(project, '.claude', 'rules', 'archive.md')
    mkdirSync(dirname(rulesPath), { recursive: true })
    // pre-create a user-edited rule + settings with an existing user hook
    writeFileSync(rulesPath, '# 用户的自定义归档规则', 'utf8')
    const settingsPath = join(project, '.claude', 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash(ls*)', hooks: [{ type: 'command', command: 'ls' }] }] } }),
    )

    await syncProjectAssets(project, { assetsDir: REPO_ASSETS })

    expect(readFileSync(rulesPath, 'utf8')).toBe('# 用户的自定义归档规则')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const pre = settings.hooks.PreToolUse
    expect(pre).toHaveLength(2) // user hook preserved + workmate hook added
    expect(pre.some((e: { matcher: string }) => e.matcher === 'Bash(git commit*)')).toBe(true)

    await syncProjectAssets(project, { assetsDir: REPO_ASSETS })
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse).toHaveLength(2)
  })
})
