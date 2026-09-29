/**
 * review.md parser (change add-proposal-quality-gates, design D4): the report
 * produced by the proposal-auditor subagent has a machine-readable contract —
 * four fixed section headers; CRITICAL entries are checkboxes whose state is
 * the resolution state. The parser is a pure function over the file content;
 * missing sections parse as empty arrays.
 */
export interface CriticalIssue {
  text: string
  resolved: boolean
}

export interface ReviewReport {
  confirms: string[]
  questions: string[]
  suggestions: string[]
  criticals: CriticalIssue[]
}

const SECTIONS = ['确认项', '疑问项', '建议补充项', 'CRITICAL 问题'] as const

export const EMPTY_REPORT: ReviewReport = { confirms: [], questions: [], suggestions: [], criticals: [] }

/** The template's CRITICAL marker, e.g. `- [ ] CRIT-1 描述` / `- [x] …`. */
const CRITICAL_LINE = /^- \[([ xX])\]\s*(.+)$/
const LIST_LINE = /^- \[(?:[ xX])\]\s*(.+)$/
const PLAIN_LINE = /^[-*]\s+(.+)$/

export function parseReviewMd(content: string): ReviewReport {
  const report: ReviewReport = { confirms: [], questions: [], suggestions: [], criticals: [] }
  let current: (typeof SECTIONS)[number] | undefined

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const header = /^##\s+(.+?)\s*$/.exec(line)
    if (header !== null) {
      const title = header[1] ?? ''
      current = SECTIONS.find((section) => title === section)
      continue
    }
    if (current === undefined || line === '' || line.startsWith('>')) continue

    if (current === 'CRITICAL 问题') {
      const match = CRITICAL_LINE.exec(line)
      if (match !== null) {
        report.criticals.push({ text: (match[2] ?? '').trim(), resolved: match[1] !== ' ' })
      }
      continue
    }

    const item = (LIST_LINE.exec(line) ?? PLAIN_LINE.exec(line))?.[1]
    if (item !== undefined && item.trim() !== '') {
      const bucket = current === '确认项' ? report.confirms : current === '疑问项' ? report.questions : report.suggestions
      bucket.push(item.trim())
    }
  }
  return report
}

export function unresolvedCriticals(report: ReviewReport): CriticalIssue[] {
  return report.criticals.filter((issue) => !issue.resolved)
}
