import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectDefaultBranch, listProjectBranches } from './branches.ts'

let root: string

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolvePromise(stdout)
    })
  })

const configure = async (cwd: string): Promise<void> => {
  await git(['config', 'user.email', 'test@example.com'], cwd)
  await git(['config', 'user.name', 'Test'], cwd)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workmate-branches-'))
  await git(['init', '-b', 'main'], root)
  await configure(root)
  await git(['commit', '--allow-empty', '-m', 'init'], root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('branches', () => {
  it('lists current/local branches and detects main', async () => {
    await git(['branch', 'dev'], root)
    await expect(listProjectBranches(root)).resolves.toEqual({
      current: 'main',
      default: 'main',
      local: ['dev', 'main'],
      remote: [],
    })
  })

  it('prefers a configured default that exists locally', async () => {
    await git(['branch', 'test'], root)
    const result = await listProjectBranches(root, 'test')
    expect(result.default).toBe('test')
  })

  it('falls back to detection when the configured default is missing', async () => {
    await expect(listProjectBranches(root, 'gone')).resolves.toMatchObject({ default: 'main' })
  })

  it('detects master when main is absent', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'workmate-branches-master-'))
    try {
      await git(['init', '-b', 'master'], bare)
      await configure(bare)
      await git(['commit', '--allow-empty', '-m', 'init'], bare)
      await expect(detectDefaultBranch(bare)).resolves.toBe('master')
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('rejects a non-git directory with a readable error', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'workmate-branches-plain-'))
    try {
      await expect(listProjectBranches(plain)).rejects.toThrow()
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
