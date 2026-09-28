import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listProposalCommits } from './git.ts'

let repo: string
let plain: string

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolvePromise()
    })
  })
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'workmate-git-'))
  plain = await mkdtemp(join(tmpdir(), 'workmate-plain-'))
  await git(['init'], repo)
  await git(['config', 'user.email', 't@t'], repo)
  await git(['config', 'user.name', 't'], repo)
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})

describe('listProposalCommits', () => {
  it('collects commits whose message mentions [proposal:<id>]', async () => {
    const file = join(repo, 'a.txt')
    await (await import('node:fs/promises')).writeFile(file, 'one', 'utf8')
    await git(['add', '.'], repo)
    await git(['commit', '-m', 'feat: 批量批改接口 [proposal:batch-grading-v2]'], repo)
    await (await import('node:fs/promises')).writeFile(file, 'two', 'utf8')
    await git(['commit', '-am', 'chore: 无关联提交'], repo)

    const result = await listProposalCommits(repo, 'batch-grading-v2')

    expect(result.note).toBeUndefined()
    expect(result.commits).toHaveLength(1)
    expect(result.commits[0]?.subject).toContain('批量批改接口')
    expect(result.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('degrades to a note when the directory is not a git repository', async () => {
    const result = await listProposalCommits(plain, 'p1')
    expect(result.commits).toEqual([])
    expect(result.note).toBeTruthy()
  })
})
