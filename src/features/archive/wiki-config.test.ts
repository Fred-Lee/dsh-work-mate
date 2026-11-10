/**
 * `weknoraEnabled` / `weknoraWikiRequired` 的语义（整体体检 #10/#11）。
 *
 * 两个配置项此前是**死配置**：只在 `Config` 里定义，归档门从不读它们，
 * 于是 README 承诺的「`weknoraWikiRequired=false` 时自动降级、不阻断」并不存在——
 * 只要 `tasks.md` 写了 `<!-- wiki: true -->`，merging 就被无条件拦住（实测 2026-11-10）。
 *
 * 这三个用例把语义钉住：
 *   - 默认（false）：缺页面只记录 gate-failed，**不阻断**；
 *   - true：缺页面阻断，错误里点名缺哪类页面；
 *   - weknoraEnabled=false：整条校验跳过，连记录都不写。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { EventLog } from '../proposal/events.ts'

let home: string
let root: string
let proposals: ProposalServiceImpl
let events: EventLog

/** 一个声明了 `wiki: true` 但只登记了 concept 的变更（technical 还缺 synthesis）。 */
const seedChange = async (): Promise<void> => {
  const dir = join(root, 'openspec', 'changes', 'wiki-p')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'tasks.md'),
    ['- [x] 1. 技术方案 <!-- wiki: true -->', '- [x] 2. 已完成 <!-- writes: src/x.ts -->'].join('\n'),
    'utf8',
  )
}

const lifecycleWith = (options: { weknoraEnabled?: boolean; weknoraWikiRequired?: boolean } = {}) =>
  new LifecycleServiceImpl({
    proposals,
    worktree: { remove: async () => ({ removed: true, summary: '' }) } as never,
    openspecRoot: 'openspec',
    mainBranch: 'main',
    approvalsRequired: [],
    resolveProjectRoots: async () => [{ project: 'demo', root }],
    orchestrate: async () => ({ ok: true, steps: [] }),
    ...options,
  })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-wiki-cfg-'))
  root = await mkdtemp(join(tmpdir(), 'wm-wiki-repo-'))
  events = new EventLog({ homeRoot: home, subdir: 'workmate' })
  // 事件日志必须挂进 service，否则 recordEvent 是 no-op，
  // 「只记录不阻断」的一半语义就测不到。
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }), undefined, events)
  await seedChange()
  await proposals.upsert({
    id: 'wiki-p',
    title: 'wiki 配置验证',
    projects: ['demo'],
    targets: [{ project: 'demo', baseBranch: 'main' }],
  })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

describe('wiki 覆盖检查读配置（#10/#11）', () => {
  it('默认 weknoraWikiRequired=false：缺页面只记录，不阻断 merging', async () => {
    const lifecycle = lifecycleWith({ weknoraEnabled: true })
    await proposals.setStatus('wiki-p', 'implementing')

    // 只登记 concept：technical 还缺 synthesis，但默认不该拦
    await expect(lifecycle.transition('wiki-p', 'merging', { actor: 'human' })).resolves.toBeDefined()

    const { events: log } = await events.read()
    const noted = log.some((event) => event.kind === 'gate-failed' && event.gate === 'wiki-coverage')
    expect(noted).toBe(true)
  })

  it('weknoraWikiRequired=true：缺页面阻断，并点名缺哪类', async () => {
    const lifecycle = lifecycleWith({ weknoraEnabled: true, weknoraWikiRequired: true })
    await proposals.setStatus('wiki-p', 'implementing')

    await expect(lifecycle.transition('wiki-p', 'merging', { actor: 'human' })).rejects.toThrow(/Wiki 关联未完成/)
  })

  it('weknoraEnabled=false：整条校验跳过，连记录都不写', async () => {
    const lifecycle = lifecycleWith({ weknoraEnabled: false, weknoraWikiRequired: true })
    await proposals.setStatus('wiki-p', 'implementing')

    await expect(lifecycle.transition('wiki-p', 'merging', { actor: 'human' })).resolves.toBeDefined()

    const { events: log } = await events.read()
    expect(log.some((event) => event.gate === 'wiki-coverage')).toBe(false)
  })
})
