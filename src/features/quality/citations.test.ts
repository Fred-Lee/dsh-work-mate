import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkCitations, fileSystemProbe, formatCitationReport, mapProbe } from './citations.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-citations-'))
  await writeFile(join(root, 'a.ts'), 'line1\nline2\nline3\n', 'utf8')
  await writeFile(join(root, 'empty.ts'), '', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkCitations', () => {
  it('accepts a resolvable file:line citation', async () => {
    const report = await checkCitations('确认：`a.ts:2` 已实现。', mapProbe({ 'a.ts': 3 }))
    expect(report.citations).toHaveLength(1)
    expect(report.citations[0]).toMatchObject({ path: 'a.ts', line: 2, verdict: 'ok' })
    expect(report.byVerdict).toMatchObject({ ok: 1, 'file-missing': 0, 'line-out-of-range': 0 })
  })

  it('parses a line range and a #L form', async () => {
    const report = await checkCitations('见 `a.ts:1-3` 与 `a.ts#L3`。', mapProbe({ 'a.ts': 3 }))
    expect(report.citations.map((citation) => [citation.line, citation.endLine])).toEqual([
      [1, 3],
      [3, 3],
    ])
    expect(report.byVerdict.ok).toBe(2)
  })

  it('flags a missing file', async () => {
    const report = await checkCitations('证据：`src/does-not-exist.ts:12`', mapProbe({ 'a.ts': 3 }))
    expect(report.byVerdict['file-missing']).toBe(1)
    expect(formatCitationReport(report)).toContain('src/does-not-exist.ts:12')
  })

  it('flags an out-of-range line but keeps the file verdict', async () => {
    const report = await checkCitations('见 `a.ts:99`。', mapProbe({ 'a.ts': 3 }))
    expect(report.byVerdict['line-out-of-range']).toBe(1)
    expect(report.byVerdict['file-missing']).toBe(0)
  })

  it('does not treat prose or commands as citations', async () => {
    const report = await checkCitations('运行 `pnpm test --filter foo`；结论来自 a.ts 与 b/c 的比较。', mapProbe({}))
    expect(report.citations).toHaveLength(0)
  })

  it('skips GitNexus query conclusions instead of pretending to verify them', async () => {
    const report = await checkCitations('结论：`impact(ArchiveGate)` 无上游影响；`context(runArchive)`。', mapProbe({}))
    expect(report.citations).toHaveLength(0)
    expect(report.notMachineCheckable).toHaveLength(2)
    expect(formatCitationReport(report)).toContain('不可机检 2 条')
  })

  it('counts each distinct citation once', async () => {
    const report = await checkCitations('`a.ts:1` 与 `a.ts:1` 是同一处。', mapProbe({ 'a.ts': 3 }))
    expect(report.citations).toHaveLength(1)
  })

  it('probes the real filesystem and refuses to escape the project root', async () => {
    const probe = fileSystemProbe(root)
    expect(await probe.lineCount('a.ts')).toBe(4) // 3 lines + trailing newline split
    expect(await probe.lineCount('empty.ts')).toBe(0)
    expect(await probe.lineCount('nope.ts')).toBeUndefined()
    expect(await probe.lineCount('../../etc/hosts')).toBeUndefined()

    const report = await checkCitations('见 `a.ts:3`。', probe)
    expect(report.byVerdict.ok).toBe(1)
  })

  it('reads review.md from disk end to end', async () => {
    await writeFile(
      join(root, 'review.md'),
      '## 确认项\n\n- `a.ts:2` 通过\n- `missing.ts:1` 不存在\n- `a.ts:500` 越界\n',
      'utf8',
    )
    const { readFile } = await import('node:fs/promises')
    const report = await checkCitations(await readFile(join(root, 'review.md'), 'utf8'), fileSystemProbe(root))
    expect(report.byVerdict).toEqual({ ok: 1, 'file-missing': 1, 'line-out-of-range': 1 })
  })
})
