/**
 * Test write-scope policy (change `autonomous-agent-team`, T4-4.5).
 *
 * Integration tests may change test code/fixtures/scripts, never production
 * source. The allowlist is intentionally file-based and explicit; a test
 * dependency change still needs its own task/approval and is not covered here.
 */
import { execFile } from 'node:child_process'

export const DEFAULT_TEST_ALLOWLIST: readonly string[] = [
  'tests/**',
  'test/**',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  'scripts/**',
]

/** Convert a small glob subset (`*`, `**`, `?`) to a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

export function isAllowedTestFile(file: string, allowlist: readonly string[] = DEFAULT_TEST_ALLOWLIST): boolean {
  const normalized = file.replace(/^\.\//, '')
  return allowlist.some((pattern) => globToRegExp(pattern).test(normalized))
}

export function testScopeViolations(
  files: readonly string[],
  allowlist: readonly string[] = DEFAULT_TEST_ALLOWLIST,
): string[] {
  return files.filter((file) => !isAllowedTestFile(file, allowlist))
}

/** `git diff --name-only <base>...HEAD`; undefined when git cannot answer (unmeasured). */
export async function changedFilesSince(projectRoot: string, baseRef: string): Promise<string[] | undefined> {
  return new Promise((resolvePromise) => {
    execFile('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: projectRoot }, (error, stdout) => {
      if (error) {
        resolvePromise(undefined)
        return
      }
      resolvePromise(
        stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      )
    })
  })
}

/** Changed + untracked files against a ref (worktree state, not just commits). */
export async function changedFilesAgainst(projectRoot: string, ref: string): Promise<string[] | undefined> {
  const run = (args: string[]): Promise<string | undefined> =>
    new Promise((resolvePromise) => {
      execFile('git', args, { cwd: projectRoot }, (error, stdout) => resolvePromise(error ? undefined : stdout))
    })
  const [tracked, untracked] = await Promise.all([
    run(['diff', '--name-only', ref]),
    run(['ls-files', '--others', '--exclude-standard']),
  ])
  if (tracked === undefined) return undefined
  return [...new Set([...tracked.split('\n'), ...(untracked ?? '').split('\n')].map((line) => line.trim()).filter((line) => line !== ''))]
}
