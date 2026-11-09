/**
 * 自动推进扫描的用例（change `auto-advance-implemented-to-merging`）。
 *
 * **任务 5 是本次变更的验收核心**：上一次实现把推进塞进 `board()`，导致宿主主线程
 * 100% 卡在 v8 MicrotaskQueue、HTTP 完全无响应（2026-11-09）。这些用例必须能抓住
 * "高频读路径 + 并发 + 写"这一类回归，而不只是判据对错。
 */
import { describe, expect, it } from 'vitest'
import {
  completedProposals,
  implementationComplete,
  runAdvanceScan,
  singleFlight,
  type ScanCard,
  type ScanProposal,
} from './advance-scan.ts'
import type { TaskRecord } from './files.ts'

const task = (id: string, proposalId?: string): TaskRecord =>
  ({
    id,
    title: id,
    intent: id,
    repo: '/r',
    baseBranch: 'main',
    acceptance: '',
    priority: 'P1',
    mode: 'superagent',
    dependsOn: [],
    assigned: true,
    abandoned: false,
    attempt: 1,
    createdBy: 'workmate:panel',
    ...(proposalId !== undefined ? { proposalId } : {}),
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  }) as TaskRecord

const card = (
  id: string,
  lane: ScanCard['lane'],
  outcome?: string,
  proposalId = 'p1',
): ScanCard => ({
  task: task(id, proposalId),
  lane,
  ...(outcome !== undefined ? { ticket: { id: `t-${id}`, title: id, ended: { outcome } } } : {}),
})

describe('implementationComplete 判据', () => {
  it('全部 completed 为完成', () => {
    expect(implementationComplete([card('a', 'done', 'completed'), card('b', 'done', 'completed')], 'p1')).toBe(true)
  })

  it('仍有待办在跑不算完成', () => {
    expect(implementationComplete([card('a', 'done', 'completed'), card('b', 'working')], 'p1')).toBe(false)
  })

  it('closed / stopped 不算完成', () => {
    expect(implementationComplete([card('a', 'done', 'closed')], 'p1')).toBe(false)
    expect(implementationComplete([card('a', 'done', 'stopped')], 'p1')).toBe(false)
  })

  it('dropped / merged 算完成', () => {
    expect(implementationComplete([card('a', 'done', 'dropped')], 'p1')).toBe(true)
    expect(implementationComplete([card('a', 'done', 'merged')], 'p1')).toBe(true)
  })

  it('无待办不算完成', () => {
    expect(implementationComplete([], 'p1')).toBe(false)
    expect(implementationComplete([card('a', 'done', 'completed', 'other')], 'p1')).toBe(false)
  })

  it('多提案独立判定', () => {
    const cards = [card('a', 'done', 'completed', 'p1'), card('b', 'working', undefined, 'p2')]
    expect(completedProposals(cards)).toEqual(['p1'])
  })
})

describe('runAdvanceScan', () => {
  const deps = (
    cards: ScanCard[],
    proposals: ScanProposal[],
    hooks: { advance?: (id: string) => Promise<void>; mark?: (id: string, at: string) => Promise<void> } = {},
  ) => ({
    cards: async () => cards,
    proposals: async () => proposals,
    advance: hooks.advance ?? (async () => undefined),
    markAdvanced: hooks.mark ?? (async () => undefined),
    now: () => new Date('2026-11-09T01:00:00.000Z'),
  })

  it('实现完成且 implementing → 推进并写标记', async () => {
    const advanced: string[] = []
    const marked: Array<[string, string]> = []
    const outcome = await runAdvanceScan(
      deps([card('a', 'done', 'completed')], [{ id: 'p1', status: 'implementing' }], {
        advance: async (id) => {
          advanced.push(id)
        },
        mark: async (id, at) => {
          marked.push([id, at])
        },
      }),
    )
    expect(outcome.advanced).toEqual(['p1'])
    expect(advanced).toEqual(['p1'])
    expect(marked[0]?.[0]).toBe('p1')
  })

  it('已有 autoAdvancedAt 时跳过（只推进一次）', async () => {
    let calls = 0
    const outcome = await runAdvanceScan(
      deps([card('a', 'done', 'completed')], [{ id: 'p1', status: 'implementing', autoAdvancedAt: '2026-11-09T00:00:00.000Z' }], {
        advance: async () => {
          calls += 1
        },
      }),
    )
    expect(outcome.skipped).toEqual(['p1'])
    expect(calls).toBe(0)
  })

  it('提案不在 implementing 时不推进', async () => {
    const outcome = await runAdvanceScan(
      deps([card('a', 'done', 'completed')], [{ id: 'p1', status: 'ready' }]),
    )
    expect(outcome.advanced).toEqual([])
    expect(outcome.skipped).toEqual(['p1'])
  })

  it('单个失败不写标记、不阻断其他提案', async () => {
    const marked: string[] = []
    const outcome = await runAdvanceScan(
      deps(
        [card('a', 'done', 'completed', 'p1'), card('b', 'done', 'completed', 'p2')],
        [
          { id: 'p1', status: 'implementing' },
          { id: 'p2', status: 'implementing' },
        ],
        {
          advance: async (id) => {
            if (id === 'p1') throw new Error('Wiki 关联未完成')
          },
          mark: async (id) => {
            marked.push(id)
          },
        },
      ),
    )
    expect(outcome.blocked.map((entry) => entry.id)).toEqual(['p1'])
    expect(outcome.blocked[0]?.reason).toContain('Wiki')
    expect(outcome.advanced).toEqual(['p2'])
    // 失败的不写标记 → 下一轮会重试
    expect(marked).toEqual(['p2'])
  })
})

describe('singleFlight（事故防线）', () => {
  it('上一轮未结束时再次调用直接返回 undefined', async () => {
    let resolveFirst: (() => void) | undefined
    const run = singleFlight(async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      return { advanced: [], blocked: [], skipped: [] }
    })

    const first = run()
    // 第一次还没结束，第二次必须立刻返回 undefined（不排队、不累积）
    expect(await run()).toBeUndefined()
    resolveFirst?.()
    expect(await first).toMatchObject({ advanced: [] })
  })

  it('上一轮抛错后仍可继续', async () => {
    let attempt = 0
    const run = singleFlight(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return { advanced: [], blocked: [], skipped: [] }
    })
    await expect(run()).rejects.toThrow('boom')
    // 关键：singleFlight 的 finally 必须复位 running，否则调度器一次失败就永久停摆
    await expect(run()).resolves.toMatchObject({ advanced: [] })
  })

  it('并发 50 次调用只会有一次真正执行（不累积）', async () => {
    let executions = 0
    const run = singleFlight(async () => {
      executions += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { advanced: [], blocked: [], skipped: [] }
    })
    const results = await Promise.all(Array.from({ length: 50 }, () => run()))
    expect(executions).toBe(1)
    expect(results.filter((result) => result !== undefined)).toHaveLength(1)
  })
})

describe('事故回归：扫描与并发读不得死锁', () => {
  it('扫描推进与 50 次并发读交错执行，全部在超时内完成且只推进一次', async () => {
    // 模拟事故里的三段结构：读路径高频并发 + 扫描带写 + 写后又有读。
    // 上次死锁的机制是"读里发起写"，这里断言读与写交错但都正常返回。
    let proposalsState: ScanProposal[] = [{ id: 'p1', status: 'implementing' }]
    const cards: ScanCard[] = [card('a', 'done', 'completed')]
    let advanceCount = 0

    const read = async (): Promise<ScanCard[]> => {
      // 只读：不写 proposalsState
      await Promise.resolve()
      return cards
    }
    const scan = singleFlight(async () =>
      runAdvanceScan({
        cards: () => read(),
        proposals: async () => proposalsState.map((proposal) => ({ ...proposal })),
        advance: async (id) => {
          advanceCount += 1
          // 推进成功后提案离开 implementing，与真实 transition 一致
          proposalsState = proposalsState.map((proposal) =>
            proposal.id === id ? { ...proposal, status: 'merging' } : proposal,
          )
        },
        markAdvanced: async (id, at) => {
          proposalsState = proposalsState.map((proposal) =>
            proposal.id === id ? { ...proposal, autoAdvancedAt: at } : proposal,
          )
        },
      }),
    )

    const work = Array.from({ length: 50 }, (_, index) =>
      index % 10 === 0 ? scan() : read(),
    )
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('DEADLOCK: 扫描与并发读未在 5 秒内完成')), 5_000),
    )

    // 若不死锁，这 50 个任务全部完成；若复现事故，这里会超时。
    await expect(Promise.race([Promise.all(work), timeout])).resolves.toBeDefined()
    // 只推进一次：后续扫描因状态已是 merging / 标记存在而跳过
    expect(advanceCount).toBe(1)
    expect(proposalsState[0]?.autoAdvancedAt).toBeDefined()
  })
})
