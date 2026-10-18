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

export type ReviewSeverity = 'CRIT' | 'HIGH' | 'MED' | 'LOW'

/** One severity-tagged checkbox line (change `add-review-tally`). */
export interface ReviewFinding {
  severity: ReviewSeverity
  /** The tag as written, e.g. `CRIT-1`. */
  tag: string
  text: string
  resolved: boolean
}

export interface ReviewerInfo {
  /** Free-form identity from the header, e.g. `auditor@1.2`. */
  reviewer?: string
  /** Shadow reports never block: the reviewer is still earning trust. */
  shadow: boolean
}

export interface ReviewReport {
  confirms: string[]
  questions: string[]
  suggestions: string[]
  criticals: CriticalIssue[]
  /** Every severity-tagged line, wherever it appears. */
  findings: ReviewFinding[]
  reviewer: ReviewerInfo
}

export interface ReviewTally {
  /** Total/open findings per severity. */
  bySeverity: Record<ReviewSeverity, { total: number; open: number }>
  findings: number
  open: number
  /** Open findings whose severity is in the configured blocking set. */
  blocking: number
  /** The open findings that would block archiving. */
  blockingFindings: ReviewFinding[]
  reviewer?: string
  shadow: boolean
}

const SECTIONS = ['确认项', '疑问项', '建议补充项', 'CRITICAL 问题'] as const

export const EMPTY_REPORT: ReviewReport = {
  confirms: [],
  questions: [],
  suggestions: [],
  criticals: [],
  findings: [],
  reviewer: { shadow: false },
}

const SEVERITIES: ReviewSeverity[] = ['CRIT', 'HIGH', 'MED', 'LOW']
/** `- [ ] HIGH-1 缺少回滚方案` / `- [x] CRIT-2 …` */
const SEVERITY_LINE = /^- \[([ xX])\]\s*(CRIT|HIGH|MED|LOW)-([A-Za-z0-9]+)?\s*(.*)$/
/** `<!-- reviewer: auditor@1.2 shadow -->` */
const REVIEWER_HEADER = /<!--\s*reviewer:\s*([^\s>]+)?\s*(shadow)?\s*-->/i

/** The template's CRITICAL marker, e.g. `- [ ] CRIT-1 描述` / `- [x] …`. */
const CRITICAL_LINE = /^- \[([ xX])\]\s*(.+)$/
const LIST_LINE = /^- \[(?:[ xX])\]\s*(.+)$/
const PLAIN_LINE = /^[-*]\s+(.+)$/

export function parseReviewMd(content: string): ReviewReport {
  const report: ReviewReport = {
    confirms: [],
    questions: [],
    suggestions: [],
    criticals: [],
    findings: [],
    reviewer: { shadow: false },
  }
  let current: (typeof SECTIONS)[number] | undefined

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const reviewerHeader = REVIEWER_HEADER.exec(line)
    if (reviewerHeader !== null) {
      report.reviewer = {
        ...(reviewerHeader[1] !== undefined && reviewerHeader[1] !== '' ? { reviewer: reviewerHeader[1] } : {}),
        shadow: reviewerHeader[2] !== undefined,
      }
      continue
    }
    const tagged = SEVERITY_LINE.exec(line)
    if (tagged !== null) {
      const severity = tagged[2] as ReviewSeverity
      report.findings.push({
        severity,
        tag: `${severity}${tagged[3] !== undefined ? `-${tagged[3]}` : ''}`,
        text: (tagged[4] ?? '').trim(),
        resolved: tagged[1] !== ' ',
      })
      if (severity === 'CRIT') {
        // Backward compatibility: `criticals[].text` keeps the tag as written
        // (`CRIT-1 描述`), which is what the pre-tally contract promised.
        report.criticals.push({
          text: line.replace(/^- \[[ xX]\]\s*/, '').trim(),
          resolved: tagged[1] !== ' ',
        })
      }
      continue
    }
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

/**
 * Machine-readable tally (change `add-review-tally`): the severity counts a check
 * run publishes, plus the shadow flag and the reviewer identity.
 */
export function reviewTally(report: ReviewReport, blockingSeverities: readonly string[] = ['CRIT']): ReviewTally {
  const bySeverity = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, { total: 0, open: 0 }]),
  ) as Record<ReviewSeverity, { total: number; open: number }>
  // Merge legacy `## CRITICAL 问题` entries with tagged findings. A critical is
  // already represented only when a tagged CRIT has the same text AND the same
  // resolution state — a resolved tagged CRIT must not hide an unresolved legacy
  // entry with the same wording.
  const legacy = report.criticals
    .filter((issue) => {
      const covered = report.findings.some(
        (finding) =>
          finding.severity === 'CRIT' &&
          finding.resolved === issue.resolved &&
          (issue.text === finding.text || issue.text.includes(finding.text)),
      )
      return !covered
    })
    .map((issue, index) => ({
      severity: 'CRIT' as const,
      tag: `LEGACY-${index + 1}`,
      text: issue.text,
      resolved: issue.resolved,
    }))
  const findings = [...report.findings, ...legacy]
  for (const finding of findings) {
    bySeverity[finding.severity].total += 1
    if (!finding.resolved) bySeverity[finding.severity].open += 1
  }
  const blockingFindings = findings.filter(
    (finding) => !finding.resolved && blockingSeverities.includes(finding.severity),
  )
  return {
    bySeverity,
    findings: findings.length,
    open: findings.filter((finding) => !finding.resolved).length,
    blocking: blockingFindings.length,
    blockingFindings,
    ...(report.reviewer.reviewer !== undefined ? { reviewer: report.reviewer.reviewer } : {}),
    shadow: report.reviewer.shadow,
  }
}

/** One-line human summary for archive step notes, e.g. `CRIT 1/2, HIGH 0/3`. */
export function formatTally(tally: ReviewTally): string {
  return SEVERITIES.filter((severity) => tally.bySeverity[severity].total > 0)
    .map((severity) => `${severity} ${tally.bySeverity[severity].open}/${tally.bySeverity[severity].total} 未解决`)
    .join(', ')
}
