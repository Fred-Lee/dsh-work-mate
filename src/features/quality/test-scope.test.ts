import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changedFilesAgainst,
  changedFilesSince,
  DEFAULT_TEST_ALLOWLIST,
  globToRegExp,
  isAllowedTestFile,
  testScopeViolations,
} from './test-scope.ts'

const git = (args: string[], cwd: string): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error) => (error ? reject(error) : resolvePromise()))
  })

describe('test write scope', () => {
  it('matches test files and rejects production source', () => {
    expect(isAllowedTestFile('tests/order.spec.ts')).toBe(true)
    expect(isAllowedTestFile('src/order.test.ts')).toBe(true)
    expect(isAllowedTestFile('scripts/verify.ts')).toBe(true)
    expect(isAllowedTestFile('src/main/order.ts')).toBe(false)
    expect(testScopeViolations(['tests/a.ts', 'src/main/order.ts'])).toEqual(['src/main/order.ts'])
    expect(DEFAULT_TEST_ALLOWLIST.length).toBeGreaterThan(0)
  })

  it('supports **/ and ? globs', () => {
    expect(globToRegExp('**/*.test.ts').test('deep/nested/a.test.ts')).toBe(true)
    expect(globToRegExp('tests/?').test('tests/a')).toBe(true)
  })
})

describe('changedFilesSince', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wm-test-scope-'))
    await git(['init', '-b', 'main'], root)
    await git(['config', 'user.email', 'test@example.com'], root)
    await git(['config', 'user.name', 'Test'], root)
    await writeFile(join(root, 'base.txt'), 'base\n', 'utf8')
    await git(['add', '.'], root)
    await git(['commit', '-m', 'base'], root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists changed files relative to the base ref', async () => {
    const base = await new Promise<string>((resolvePromise, reject) => {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: root }, (error, stdout) =>
        error ? reject(error) : resolvePromise(stdout.trim()),
      )
    })
    await writeFile(join(root, 'tests.spec.ts'), 'x\n', 'utf8')
    await git(['add', '.'], root)
    await git(['commit', '-m', 'test'], root)
    await expect(changedFilesSince(root, base)).resolves.toEqual(['tests.spec.ts'])
  })

  it('returns undefined when git cannot answer', async () => {
    await expect(changedFilesSince(root, 'missing-ref')).resolves.toBeUndefined()
  })
  it('includes tracked and untracked files against a ref', async () => {
    const base = await new Promise<string>((resolvePromise, reject) => {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: root }, (error, stdout) =>
        error ? reject(error) : resolvePromise(stdout.trim()),
      )
    })
    await writeFile(join(root, 'tracked.ts'), 'x\n', 'utf8')
    await writeFile(join(root, 'untracked.ts'), 'y\n', 'utf8')
    await git(['add', 'tracked.ts'], root)
    await expect(changedFilesAgainst(root, base)).resolves.toEqual(
      expect.arrayContaining(['tracked.ts', 'untracked.ts']),
    )
  })

})
