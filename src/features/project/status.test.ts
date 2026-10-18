import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProjectGitStatus } from './status.ts'

const git = (args: string[], cwd: string): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error) => (error ? reject(error) : resolvePromise()))
  })

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-status-'))
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await writeFile(join(root, 'a.txt'), 'a\n', 'utf8')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'init'], root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('getProjectGitStatus', () => {
  it('reports branch, head and dirty files', async () => {
    await writeFile(join(root, 'b.txt'), 'b\n', 'utf8')
    const status = await getProjectGitStatus(root)
    expect(status).toMatchObject({ branch: 'main', dirtyCount: 1, isWorktree: false })
    expect(status?.headShort.length).toBeGreaterThan(4)
  })

  it('returns undefined for a non-git directory', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'wm-status-plain-'))
    await expect(getProjectGitStatus(plain)).resolves.toBeUndefined()
    await rm(plain, { recursive: true, force: true })
  })
})
