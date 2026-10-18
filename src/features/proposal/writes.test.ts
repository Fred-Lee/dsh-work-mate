import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findWriteConflicts, readProposalWriteScopes } from './writes.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-writes-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const changeDir = (id: string): string => join(root, 'openspec', 'changes', id)

describe('readProposalWriteScopes', () => {
  it('unions design and tasks annotations, de-duplicated and sorted', async () => {
    const dir = changeDir('p1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'design.md'), '<!-- writes: src/a/**, docs/** -->\n', 'utf8')
    await writeFile(
      join(dir, 'tasks.md'),
      '- [ ] 1 <!-- writes: src/a/**, src/b/** -->\n- [ ] 2 <!-- writes: docs/** -->\n',
      'utf8',
    )

    await expect(readProposalWriteScopes(root, 'openspec', 'p1')).resolves.toEqual([
      'docs/**',
      'src/a/**',
      'src/b/**',
    ])
  })

  it('treats missing files as no declaration', async () => {
    await expect(readProposalWriteScopes(root, 'openspec', 'ghost')).resolves.toEqual([])
  })
})

describe('findWriteConflicts', () => {
  it('reports overlapping scopes in the same project only', () => {
    const conflicts = findWriteConflicts([
      { proposalId: 'a', project: 'repo', writes: ['src/main/order/**'] },
      { proposalId: 'b', project: 'repo', writes: ['src/main/order/detail/**', 'docs/**'] },
      { proposalId: 'c', project: 'other', writes: ['src/main/order/**'] },
    ])

    expect(conflicts).toEqual([
      { project: 'repo', proposalIds: ['a', 'b'], scopes: ['src/main/order/**'] },
    ])
  })

  it('ignores a proposal compared with itself and non-overlapping scopes', () => {
    expect(
      findWriteConflicts([
        { proposalId: 'a', project: 'repo', writes: ['src/a/**', 'src/b/**'] },
        { proposalId: 'b', project: 'repo', writes: ['src/c/**'] },
      ]),
    ).toEqual([])
  })
})
