import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkTargetDrift } from './drift.ts'

let root: string

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolvePromise(stdout)
    })
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-drift-'))
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await git(['commit', '--allow-empty', '-m', 'init'], root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkTargetDrift', () => {
  it('reports no drift when the base branch still points at the recorded commit', async () => {
    const baseCommit = (await git(['rev-parse', 'HEAD'], root)).trim()
    await expect(
      checkTargetDrift(root, { project: 'a', baseBranch: 'main', baseCommit }),
    ).resolves.toMatchObject({ drifted: false, currentCommit: baseCommit })
  })

  it('reports drift when the base branch moved', async () => {
    const baseCommit = (await git(['rev-parse', 'HEAD'], root)).trim()
    await git(['commit', '--allow-empty', '-m', 'next'], root)

    const drift = await checkTargetDrift(root, { project: 'a', baseBranch: 'main', baseCommit })
    expect(drift?.drifted).toBe(true)
    expect(drift?.currentCommit).not.toBe(baseCommit)
  })

  it('returns undefined when no base commit was recorded or the branch is gone', async () => {
    await expect(checkTargetDrift(root, { project: 'a', baseBranch: 'main' })).resolves.toBeUndefined()
    await expect(
      checkTargetDrift(root, { project: 'a', baseBranch: 'gone', baseCommit: 'abcdef' }),
    ).resolves.toBeUndefined()
  })
})
