/**
 * Review-evidence citation probe (change `harden-archive-gates`, design D3).
 *
 * The review.md template asks every confirmation to cite `file:line` or a GitNexus
 * query result. Nothing checked those citations, so a report could be written from
 * memory and still pass the archive gate. This module does the part a machine can
 * honestly do: a **backticked** reference must resolve to an existing file, and a
 * line number must be inside that file. Everything else (whose conclusion it is,
 * whether the conclusion is true) stays with the human reviewer.
 *
 * Two deliberate limits:
 *  - Only backticked tokens are treated as references, so prose containing slashes
 *    is not misread as a path.
 *  - GitNexus query conclusions are reported as `not-machine-checkable` instead of
 *    being silently "verified" by a probe that cannot run the query.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

export type CitationVerdict = 'ok' | 'file-missing' | 'line-out-of-range'

export interface Citation {
  /** The raw backticked token, e.g. `src/config.ts:190`. */
  raw: string
  /** Normalized path without the line part. */
  path: string
  /** 1-based single line or the first line of a range; undefined when the token has no line. */
  line?: number
  /** Last line of a `a-b` range; equals `line` for a single line. */
  endLine?: number
  verdict: CitationVerdict
}

export interface CitationReport {
  citations: Citation[]
  /** Entries naming a GitNexus query; a machine cannot check these. */
  notMachineCheckable: string[]
  byVerdict: Record<CitationVerdict, number>
}

/** A token that names a GitNexus tool call rather than a file. */
const GITNEXUS_HINT = /(?:^|[\s`(])(impact|context|query|explain|detect_changes|gitnexus)\s*\(/i

/** Backticked token: no whitespace inside, at least one `/` or a known source extension. */
const BACKTICKED = /`([^`\n]+)`/g

/** `path/file.ts:12`, `path/file.ts:12-30`, `path/file.ts#L12`, or a bare path. */
const REFERENCE = /^((?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L(\d+))?)?$/

const SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'yml', 'yaml', 'sh', 'css', 'html']

/** True when the token looks like a file path rather than a bare identifier or a version. */
function looksLikePath(token: string): boolean {
  if (token.includes('/')) return true
  const dot = token.lastIndexOf('.')
  if (dot === -1) return false
  return SOURCE_EXTENSIONS.includes(token.slice(dot + 1).toLowerCase())
}

export interface CitationProbe {
  /** Line count of a project-relative file, or undefined when it does not exist. */
  lineCount(relativePath: string): Promise<number | undefined>
}

/** Default probe: resolves references against a project root. */
export function fileSystemProbe(projectRoot: string): CitationProbe {
  return {
    async lineCount(relativePath: string): Promise<number | undefined> {
      const absolute = isAbsolute(relativePath) ? relativePath : join(projectRoot, normalize(relativePath))
      // Never escape the project root through `..` in a report.
      if (!isAbsolute(relativePath) && !normalize(join(projectRoot, relativePath)).startsWith(normalize(projectRoot))) {
        return undefined
      }
      try {
        const info = await stat(absolute)
        if (!info.isFile()) return undefined
      } catch {
        return undefined
      }
      try {
        const text = await readFile(absolute, 'utf8')
        return text === '' ? 0 : text.split('\n').length
      } catch {
        return undefined
      }
    },
  }
}

/** In-memory probe for tests (`{ 'src/a.ts': 10 }`). */
export function mapProbe(files: Record<string, number>): CitationProbe {
  return {
    async lineCount(relativePath: string): Promise<number | undefined> {
      return Object.hasOwn(files, relativePath) ? files[relativePath] : undefined
    },
  }
}

/**
 * Extract and check every backticked citation of `content`.
 * @param content - the review.md body.
 * @param probe - line-count probe, usually {@link fileSystemProbe}.
 * @returns the per-citation verdicts plus the entries a machine refuses to judge.
 */
export async function checkCitations(content: string, probe: CitationProbe): Promise<CitationReport> {
  const citations: Citation[] = []
  const notMachineCheckable: string[] = []
  const seen = new Set<string>()

  for (const match of content.matchAll(BACKTICKED)) {
    const raw = (match[1] ?? '').trim()
    if (raw === '' || seen.has(raw)) continue
    if (GITNEXUS_HINT.test(raw)) {
      seen.add(raw)
      notMachineCheckable.push(raw)
      continue
    }
    // A backticked command / identifier with spaces is never a path reference.
    if (/\s/.test(raw)) continue
    const parsed = REFERENCE.exec(raw)
    if (parsed === null) continue
    // The extension check runs on the path part, not the raw token: `a.ts:2` ends
    // in `ts:2`, which is not an extension.
    if (!looksLikePath(parsed[1] as string)) continue
    seen.add(raw)
    const path = parsed[1] as string
    const lineRaw = parsed[2] ?? parsed[4]
    const endRaw = parsed[3] ?? parsed[5]
    const line = lineRaw === undefined ? undefined : Number.parseInt(lineRaw, 10)
    const endLine = endRaw === undefined ? line : Number.parseInt(endRaw, 10)
    const count = await probe.lineCount(path)
    let verdict: CitationVerdict
    if (count === undefined) verdict = 'file-missing'
    else if (line !== undefined && (line < 1 || line > Math.max(count, 1))) verdict = 'line-out-of-range'
    else verdict = 'ok'
    citations.push({
      raw,
      path,
      ...(line !== undefined ? { line } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      verdict,
    })
  }

  const byVerdict: Record<CitationVerdict, number> = { ok: 0, 'file-missing': 0, 'line-out-of-range': 0 }
  for (const citation of citations) byVerdict[citation.verdict] += 1
  return { citations, notMachineCheckable, byVerdict }
}

/** One-line human summary for an archive step. */
export function formatCitationReport(report: CitationReport): string {
  const parts = [
    `引用 ${report.citations.length} 条（ok ${report.byVerdict.ok}`,
    `文件缺失 ${report.byVerdict['file-missing']}`,
    `行号越界 ${report.byVerdict['line-out-of-range']}）`,
  ]
  if (report.notMachineCheckable.length > 0) {
    parts.push(`不可机检 ${report.notMachineCheckable.length} 条（GitNexus 查询结论）`)
  }
  const missing = report.citations.filter((citation) => citation.verdict === 'file-missing').slice(0, 5)
  if (missing.length > 0) parts.push(`缺失示例：${missing.map((citation) => citation.raw).join('，')}`)
  return parts.join('；')
}
