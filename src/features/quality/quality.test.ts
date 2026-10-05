import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatTally, parseReviewMd, reviewTally, unresolvedCriticals } from './review-parser.ts'
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
    expect(report.findings.map((finding) => [finding.severity, finding.tag, finding.resolved])).toEqual([
      ['CRIT', 'CRIT-1', false],
      ['CRIT', 'CRIT-2', true],
    ])
    expect(report.reviewer).toEqual({ shadow: false })
  })

  it('missing sections parse as empty arrays', () => {
    expect(parseReviewMd('')).toEqual({
      confirms: [],
      questions: [],
      suggestions: [],
      criticals: [],
      findings: [],
      reviewer: { shadow: false },
    })
  })
})

describe('review tally (add-review-tally)', () => {
  const report = parseReviewMd(
    [
      '# Review',
      '<!-- reviewer: auditor@1.2 shadow -->',
      '',
      '## 确认项',
      '- [x] 需求映射完整',
      '## 疑问项',
      '- [ ] HIGH-1 缺少回滚演练证据',
      '- [ ] MED-1 命名不一致',
      '## 建议补充项',
      '- [ ] LOW-1 可读性',
      '## CRITICAL 问题',
      '- [ ] CRIT-2 消费方遗漏',
      '- [x] CRIT-1 已修复',
    ].join('\n'),
  )

  it('counts findings per severity and reads the reviewer header', () => {
    const tally = reviewTally(report)

    expect(tally.bySeverity.CRIT).toEqual({ total: 2, open: 1 })
    expect(tally.bySeverity.HIGH).toEqual({ total: 1, open: 1 })
    expect(tally.bySeverity.MED).toEqual({ total: 1, open: 1 })
    expect(tally.bySeverity.LOW).toEqual({ total: 1, open: 1 })
    expect(tally.reviewer).toBe('auditor@1.2')
    expect(tally.shadow).toBe(true)
    expect(tally.findings).toBe(5)
    expect(tally.open).toBe(4)
  })

  it('blocks only the configured severities and summarises them', () => {
    expect(reviewTally(report).blocking).toBe(1)
    expect(reviewTally(report, ['CRIT', 'HIGH']).blocking).toBe(2)
    expect(reviewTally(report, ['CRIT', 'HIGH']).blockingFindings.map((finding) => finding.text)).toEqual([
      '缺少回滚演练证据',
      '消费方遗漏',
    ])
    expect(formatTally(reviewTally(report))).toBe('CRIT 1/2 未解决, HIGH 1/1 未解决, MED 1/1 未解决, LOW 1/1 未解决')
  })

  it('falls back to the untagged CRITICAL section for legacy reports', () => {
    const legacy = parseReviewMd('## CRITICAL 问题\n\n- [ ] 未标标签的严重问题\n')
    const tally = reviewTally(legacy)

    expect(legacy.findings).toEqual([])
    expect(tally.bySeverity.CRIT).toEqual({ total: 1, open: 1 })
    expect(tally.blocking).toBe(1)
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

  it('distributes only the OpenSpec set when Claude assets are switched off', async () => {
    const result = await syncProjectAssets(project, { assetsDir: REPO_ASSETS, claudeAssets: false })

    expect(result.written).toContain('openspec/config.yaml')
    expect(result.written).toContain('openspec/schemas/workmate-review/schema.yaml')
    expect(result.written.some((path) => path.startsWith('.claude/'))).toBe(false)
    expect(result.note).toContain('claudeAssetsEnabled=false')
    expect(existsSync(join(project, '.claude'))).toBe(false)
  })
})
