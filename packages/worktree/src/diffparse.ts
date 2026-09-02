/**
 * Unified-diff parsing — turns `git diff` output into per-file records with
 * addition/deletion counts. Zero dependencies, tolerant of renames and
 * binary files.
 */

export interface ParsedFileDiff {
  path: string
  oldPath?: string
  binary: boolean
  additions: number
  deletions: number
  /** Full `diff --git` section for this file, verbatim. */
  diff: string
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/m
const RENAME_FROM_RE = /^rename from (.+)$/

export function parseUnifiedDiff(diffText: string): ParsedFileDiff[] {
  const sections = splitSections(diffText)
  const files: ParsedFileDiff[] = []
  for (const section of sections) {
    const headerMatch = section.match(DIFF_GIT_RE)
    if (!headerMatch) continue
    const oldPath = headerMatch[1]!
    const newPath = headerMatch[2]!
    let path = newPath
    let binary = false
    let additions = 0
    let deletions = 0
    let renamedFrom: string | undefined

    const lines = section.split('\n')
    let inHunk = false
    for (const line of lines) {
      if (line.startsWith('@@')) {
        inHunk = true
        continue
      }
      if (!inHunk) {
        const rename = line.match(RENAME_FROM_RE)
        if (rename) {
          renamedFrom = rename[1]!
          path = renamedFrom
          continue
        }
        if (line.startsWith('GIT binary patch') || line.startsWith('Binary files')) {
          binary = true
        }
        if (line.startsWith('+++') || line.startsWith('---')) {
          const p = extractPath(line)
          if (p && p !== '/dev/null') path = p
        }
        continue
      }
      if (line.startsWith('+')) additions += 1
      else if (line.startsWith('-')) deletions += 1
      else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — not a content line
      }
    }
    files.push({
      path,
      ...(renamedFrom ? { oldPath: renamedFrom } : {}),
      binary,
      additions,
      deletions,
      diff: section.endsWith('\n') ? section : `${section}\n`,
    })
  }
  return files
}

function splitSections(diffText: string): string[] {
  const out: string[] = []
  let current: string[] = []
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      out.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) out.push(current.join('\n'))
  return out
}

function extractPath(line: string): string | undefined {
  // `+++ b/src/foo.ts` / `--- a/src/foo.ts` / `+++ /dev/null`
  const m = line.match(/^(?:\+\+\+|---) (.+?)(?:\t.*)?$/)
  if (!m) return undefined
  let p = m[1]!
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  return p
}

/** Extracts changed line ranges per file from a unified diff, for conflict detection. */
export function changedLineRanges(diffText: string): Map<string, Array<{ start: number; end: number }>> {
  const ranges = new Map<string, Array<{ start: number; end: number }>>()
  for (const file of parseUnifiedDiff(diffText)) {
    const list: Array<{ start: number; end: number }> = []
    for (const line of file.diff.split('\n')) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      if (hunk) {
        const start = Number(hunk[1])
        const count = hunk[2] === undefined ? 1 : Number(hunk[2])
        list.push({ start, end: start + Math.max(count, 0) })
      }
    }
    ranges.set(file.path, list)
  }
  return ranges
}
