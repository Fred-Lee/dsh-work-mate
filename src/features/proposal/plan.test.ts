import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computePlanFingerprint } from './plan.ts'

let root: string
let changeDir: string

const write = async (path: string, content: string): Promise<void> => {
  await mkdir(join(changeDir, path, '..'), { recursive: true })
  await writeFile(join(changeDir, path), content, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-plan-'))
  changeDir = join(root, 'openspec', 'changes', 'p1')
  await mkdir(changeDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('computePlanFingerprint', () => {
  it('hashes required files and specs deterministically', async () => {
    await write('proposal.md', '# p\n')
    await write('design.md', '# d\n')
    await write('tasks.md', '- [ ] t\n')
    await write('specs/cap/spec.md', '## ADDED Requirements\n')

    const first = await computePlanFingerprint(root, 'openspec', 'p1')
    const second = await computePlanFingerprint(root, 'openspec', 'p1')

    expect(first.missing).toEqual([])
    expect(first.files).toEqual(['design.md', 'proposal.md', 'specs/cap/spec.md', 'tasks.md'])
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.hash).toBe(first.hash)
  })

  it('changes the hash when any plan artifact changes', async () => {
    await write('proposal.md', '# p\n')
    await write('design.md', '# d\n')
    await write('tasks.md', '- [ ] t\n')
    const before = await computePlanFingerprint(root, 'openspec', 'p1')

    await write('tasks.md', '- [x] t\n')
    const checkboxOnly = await computePlanFingerprint(root, 'openspec', 'p1')
    expect(checkboxOnly.hash).toBe(before.hash)

    await write('tasks.md', '- [ ] changed text\n')
    const after = await computePlanFingerprint(root, 'openspec', 'p1')
    expect(before.hash).not.toBe(after.hash)
  })

  it('names missing required files and returns no hash', async () => {
    await write('proposal.md', '# p\n')
    const result = await computePlanFingerprint(root, 'openspec', 'p1')

    expect(result.hash).toBeUndefined()
    expect(result.missing).toEqual(['design.md', 'tasks.md'])
    expect(result.files).toEqual(['proposal.md'])
  })

  it('treats specs as optional', async () => {
    await write('proposal.md', '# p\n')
    await write('design.md', '# d\n')
    await write('tasks.md', '- [ ] t\n')
    const result = await computePlanFingerprint(root, 'openspec', 'p1')

    expect(result.missing).toEqual([])
    expect(result.files).toEqual(['design.md', 'proposal.md', 'tasks.md'])
    expect(result.hash).toBeDefined()
  })
})
