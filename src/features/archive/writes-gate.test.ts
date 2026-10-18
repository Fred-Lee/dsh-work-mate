import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { WorktreeManager } from '../worktree/manager.ts'

let home: string
let project: string
let proposals: ProposalServiceImpl
let lifecycle: LifecycleServiceImpl

const writeChange = async (id: string, writes: string): Promise<void> => {
  const dir = join(project, 'openspec', 'changes', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'tasks.md'), `- [ ] 1 <!-- writes: ${writes} -->\n`, 'utf8')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-writes-gate-'))
  project = await mkdtemp(join(tmpdir(), 'wm-writes-gate-proj-'))
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }))
  lifecycle = new LifecycleServiceImpl({
    proposals,
    worktree: new WorktreeManager({
      homeRoot: home,
      subdir: 'workmate',
      basePort: 3000,
      portStep: 10,
      copyFiles: [],
      packageManager: 'pnpm',
    }),
    openspecRoot: 'openspec',
    mainBranch: 'main',
    approvalsRequired: [],
    resolveProjectRoots: async () => [{ project: 'demo', root: project }],
    orchestrate: async () => ({ ok: true, steps: [] }),
  })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('implementing write-scope gate', () => {
  it('blocks when declared scopes overlap with another active proposal', async () => {
    await writeChange('p1', 'src/main/order/**')
    await writeChange('p2', 'src/main/order/detail/**')
    await proposals.upsert({ id: 'p1', title: 'p1', projects: ['demo'] })
    await proposals.upsert({ id: 'p2', title: 'p2', projects: ['demo'] })
    await proposals.setStatus('p1', 'ready')
    await proposals.setStatus('p2', 'ready')

    await expect(lifecycle.transition('p1', 'implementing')).rejects.toThrow(/写域冲突/)
    expect((await proposals.get('p1'))?.status).toBe('ready')
  })

  it('ignores an archived proposal that declared the same scope', async () => {
    await writeChange('p1', 'src/main/order/**')
    await writeChange('p2', 'src/main/order/**')
    await proposals.upsert({ id: 'p1', title: 'p1', projects: ['demo'] })
    await proposals.upsert({ id: 'p2', title: 'p2', projects: ['demo'] })
    await proposals.setStatus('p1', 'ready')
    await proposals.setStatus('p2', 'archived')

    // No conflict from the archived proposal; the transition proceeds into the
    // worktree step and fails there because the temp project is not a git repo.
    await expect(lifecycle.transition('p1', 'implementing')).rejects.not.toThrow(/写域冲突/)
  })
})
