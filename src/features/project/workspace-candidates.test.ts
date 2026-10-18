import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from './registry.ts'
import { listWorkspaceCandidates } from './workspace-candidates.ts'

let home: string
let registry: ProjectRegistry

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-workspace-candidates-'))
  registry = new ProjectRegistry({ homeRoot: home, subdir: 'workmate' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const makeRepo = async (path: string, withOpenspec = false): Promise<void> => {
  await mkdir(join(path, '.git'), { recursive: true })
  if (withOpenspec) await mkdir(join(path, 'openspec'), { recursive: true })
}

describe('listWorkspaceCandidates', () => {
  it('keeps git repos, marks registered roots, and skips non-git folders', async () => {
    const a = join(home, 'a')
    const b = join(home, 'b')
    const plain = join(home, 'plain')
    await makeRepo(a, true)
    await makeRepo(b)
    await mkdir(plain, { recursive: true })
    await registry.upsert('b', b, { defaultBranch: 'main', workspace: 'xkw' })

    const candidates = await listWorkspaceCandidates(
      {
        list: () => [
          { path: a, title: 'Alpha' },
          { path: b, title: 'Beta' },
          { path: plain, title: 'Plain' },
        ],
      },
      registry,
    )

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      path: a,
      title: 'Alpha',
      name: 'a',
      suggestedName: 'a',
      registered: false,
      hasOpenspec: true,
      workspace: 'Alpha',
    })
    expect(candidates[1]).toMatchObject({
      path: b,
      registered: true,
      registeredAs: 'b',
      suggestedName: 'b',
    })
  })

  it('suggests a suffix when the basename collides with another root', async () => {
    const first = join(home, 'one', 'demo')
    const second = join(home, 'two', 'demo')
    await makeRepo(first)
    await makeRepo(second)
    await registry.upsert('demo', first)

    const candidates = await listWorkspaceCandidates(
      {
        list: () => [
          { path: first, title: '' },
          { path: second, title: '' },
        ],
      },
      registry,
    )

    const secondCandidate = candidates.find((candidate) => candidate.path === second)
    expect(secondCandidate).toMatchObject({ name: 'demo', suggestedName: 'demo-2', registered: false })
    // Empty title falls back to the parent directory as the workspace label.
    expect(secondCandidate?.workspace).toBe('two')
  })

  it('de-duplicates the same canonical path reported twice', async () => {
    const a = join(home, 'dup')
    await makeRepo(a)
    const candidates = await listWorkspaceCandidates(
      {
        list: () => [
          { path: a, title: 'one' },
          { path: a, title: 'two' },
        ],
      },
      registry,
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.title).toBe('one')
  })
})
