// @vitest-environment jsdom
/**
 * Run-panel tests (jsdom + @testing-library).
 *
 * Locked behaviours (spec task-kanban 「冲突裁决与合并由用户决定」+「run 实时面板」):
 *  1. 冲突行只有一个"跳转对比"入口,面板内不存在任何自动合并 / 一键采纳控件
 *  2. SSE 驱动时间线更新,断线按 cursor 重连(续传不重复)
 *  3. 无 SSE 时回退轮询 /api/run/:taskId/events
 *  4. 审批挂起显示"待审批令牌";已 merge run 的受影响服务候选经用户勾选才写入关联
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunPanel, describeEvent } from './RunPanel'
import { installFetch, makeRun } from './test-helpers'
import type { CardRunPayload } from './api'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static reset(): void {
    FakeEventSource.instances = []
  }
  url: string
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  private named = new Map<string, Set<(ev: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    if (!this.named.has(type)) this.named.set(type, new Set())
    this.named.get(type)!.add(cb)
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.named.get(type)?.delete(cb)
  }

  open(): void {
    this.onopen?.({})
  }

  message(data: string): void {
    this.onmessage?.({ data })
  }

  error(): void {
    this.onerror?.(new Event('error'))
  }

  event(type: string): void {
    for (const cb of this.named.get(type) ?? []) cb({})
  }
}

function logEvent(seq: number, agent: string, text: string): string {
  return JSON.stringify({ v: 1, seq, ts: seq * 1000, taskId: 't-1', kind: 'agent-log', agent, payload: { text } })
}

function startEvent(seq: number, agent: string): string {
  return JSON.stringify({ v: 1, seq, ts: seq * 1000, taskId: 't-1', kind: 'run-start', agent, payload: { attempt: 1 } })
}

let fetchCalls: ReturnType<typeof installFetch>['calls']

// The suite is timing-sensitive (SSE backoff timers); keep the default retry
// window generous so a loaded machine cannot produce flaky failures.
configure({ asyncUtilTimeout: 5_000 })

beforeEach(() => {
  FakeEventSource.reset()
  fetchCalls = installFetch(() => ({ events: [], pruned: false, after: 0, nextCursor: 0, task: null })).calls
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function expandFirstRun(container: HTMLElement): HTMLElement {
  const toggle = container.querySelector('[data-role="run-toggle"]') as HTMLElement
  fireEvent.click(toggle)
  return container.querySelector('[data-role="run-panel"]') as HTMLElement
}

describe('冲突行只有跳转入口(不得出现自动合并/一键采纳)', () => {
  const runs: CardRunPayload[] = [
    makeRun({
      taskId: 't-1',
      state: 'merged',
      stateLabel: '已合并',
      merged: true,
      mergedAt: 5_000,
      conflicts: [{ agent: 'claude', path: 'src/login.ts', href: '/helmsman-diff/?task=t-1' }],
    }),
  ]

  function renderPanel(): HTMLElement {
    const view = render(
      <RunPanel
        runs={runs}
        approvals={[]}
        streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream"
        pollMs={5_000}
        historyAvailable
      />,
    )
    return expandFirstRun(view.container)
  }

  it('冲突文件只提供"跳转对比"链接,指向既有 diff 界面', () => {
    const panel = renderPanel()
    const jumps = panel.querySelectorAll('[data-role="conflict-jump"]')
    expect(jumps.length).toBe(1)
    const jump = jumps[0] as HTMLAnchorElement
    expect(jump.getAttribute('href')).toBe('/helmsman-diff/?task=t-1')
    expect(jump.textContent).toContain('跳转对比')
    expect(jump.getAttribute('target')).toBe('_blank')
    // 冲突行内只有这一个控件
    const row = panel.querySelector('[data-role="conflict-row"]') as HTMLElement
    expect(within(row).getAllByRole('link').length).toBe(1)
    expect(within(row).queryAllByRole('button').length).toBe(0)
  })

  it('面板树中不存在自动合并 / 一键采纳 / 自动裁决控件', () => {
    const panel = renderPanel()
    const banned = /自动合并|自动裁决|自动选取|自动解决|一键采纳|一键合并|合并所选|采纳/
    for (const control of [...panel.querySelectorAll('button, a')]) {
      expect(control.textContent ?? '').not.toMatch(banned)
    }
    // 说明性文案也不得暗示系统代选
    expect(panel.textContent ?? '').not.toMatch(/自动合并|自动裁决|自动选取|一键采纳/)
    // 合并后的唯一提示是把用户引到对比界面
    expect(panel.textContent).toContain('冲突裁决在对比界面完成')
  })
})

describe('时间线事件映射', () => {
  it('把 durable 事件映射为可读行,冲突行只带跳转标记', () => {
    const rows = describeEvent({
      v: 1,
      seq: 3,
      ts: 300,
      taskId: 't-1',
      kind: 'task-state',
      payload: {
        id: 't-1',
        prompt: 'p',
        status: 'AGGREGATING',
        cascade: false,
        timeoutSec: 60,
        createdAt: 1,
        agents: { claude: { agent: 'claude', state: 'completed', attempts: 1, hasDiff: true, conflictingFiles: ['src/a.ts'] } },
      },
    })
    expect(rows.map((r) => r.kind)).toEqual(['state', 'conflict'])
    expect(rows[1]!.conflictPath).toBe('src/a.ts')
  })

  it('merge-decision 记录用户裁决数量', () => {
    const rows = describeEvent({
      v: 1,
      seq: 9,
      ts: 900,
      taskId: 't-1',
      kind: 'merge-decision',
      payload: {
        agents: ['claude'],
        resolutions: { 'src/a.ts': { kind: 'manual' } },
        conflictFiles: ['src/a.ts'],
        discardAfterMerge: false,
        outcome: 'merged',
        results: [],
      },
    })
    expect(rows[0]!.text).toContain('合并已执行')
    expect(rows[0]!.text).toContain('用户裁决 1 个文件')
    expect(rows[1]!.conflictPath).toBe('src/a.ts')
  })
})

describe('SSE 实时时间线', () => {
  it('展开 run 后订阅 dashboard SSE 并按事件更新时间线', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const view = render(
      <RunPanel
        runs={[makeRun()]}
        approvals={[]}
        streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream"
        pollMs={5_000}
        historyAvailable
      />,
    )
    expandFirstRun(view.container)

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    const source = FakeEventSource.instances[0]!
    expect(source.url).toBe('/helmsman-dashboard/api/task/t-1/stream?after=0')

    act(() => {
      source.open()
      source.message(startEvent(1, 'claude'))
      source.message(logEvent(2, 'claude', 'claude: 修改登录接口\n'))
    })

    await waitFor(() => {
      expect(view.container.querySelector('[data-role="run-timeline"]')?.textContent).toContain('claude 启动')
      expect(view.container.querySelector('[data-role="run-timeline"]')?.textContent).toContain('claude: 修改登录接口')
      expect(view.container.querySelector('[data-role="timeline-status"]')?.textContent).toContain('实时(SSE)')
    })
  })

  it('断线按最后 cursor 重连,续传不重复', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    // Injectable backoff so the reconnect is deterministic (no real-time wait).
    const view = render(
      <RunPanel
        runs={[makeRun()]}
        approvals={[]}
        streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream"
        pollMs={5_000}
        historyAvailable
        streamOptions={{ minReconnectMs: 1, maxReconnectMs: 2 }}
      />,
    )
    expandFirstRun(view.container)
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    const first = FakeEventSource.instances[0]!
    act(() => {
      first.open()
      first.message(logEvent(2, 'claude', 'line A\n'))
      first.message(logEvent(3, 'claude', 'line B\n'))
    })

    act(() => first.error())
    // manual reconnect carries the last processed seq (after=3)
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2), { timeout: 5_000 })
    expect(FakeEventSource.instances[1]!.url).toBe('/helmsman-dashboard/api/task/t-1/stream?after=3')

    act(() => {
      FakeEventSource.instances[1]!.open()
      FakeEventSource.instances[1]!.message(logEvent(4, 'claude', 'line C\n'))
    })
    await waitFor(() => {
      const text = (view.container.querySelector('[data-role="run-timeline"]') as HTMLElement).textContent ?? ''
      expect(text.match(/line A/g)?.length).toBe(1)
      expect(text.match(/line B/g)?.length).toBe(1)
      expect(text.match(/line C/g)?.length).toBe(1)
    })
  })

  it('history-pruned 信号显示裁剪提示', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const view = render(<RunPanel runs={[makeRun()]} approvals={[]} streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream" pollMs={5_000} historyAvailable />)
    expandFirstRun(view.container)
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    act(() => {
      FakeEventSource.instances[0]!.open()
      FakeEventSource.instances[0]!.event('history-pruned')
    })
    await waitFor(() => expect(view.container.querySelector('[data-role="history-pruned"]')).not.toBeNull())
  })
})

describe('SSE 不可用时回退轮询', () => {
  it('无 EventSource 时轮询 /api/run/:taskId/events 并渲染事件', async () => {
    vi.stubGlobal('EventSource', undefined)
    fetchCalls = installFetch((url) => {
      if (url.includes('/api/run/t-1/events')) {
        return { task: { id: 't-1', status: 'RUNNING', prompt: 'p' }, events: [JSON.parse(logEvent(2, 'claude', '轮询到的日志\n'))], pruned: false, after: 0, nextCursor: 2 }
      }
      return {}
    }).calls

    const view = render(<RunPanel runs={[makeRun()]} approvals={[]} streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream" pollMs={5_000} historyAvailable />)
    expandFirstRun(view.container)

    await waitFor(() => expect(fetchCalls.some((call) => call.url.includes('/api/run/t-1/events?after='))).toBe(true))
    await waitFor(() => {
      const timeline = view.container.querySelector('[data-role="run-timeline"]') as HTMLElement
      expect(timeline.textContent).toContain('轮询到的日志')
      expect(view.container.querySelector('[data-role="timeline-status"]')?.textContent).toContain('轮询')
    })
  })

  it('历史服务不可用时显示不可用而不是报错', async () => {
    vi.stubGlobal('EventSource', undefined)
    const view = render(<RunPanel runs={[makeRun()]} approvals={[]} streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream" pollMs={5_000} historyAvailable={false} />)
    expandFirstRun(view.container)
    await waitFor(() => expect(view.container.textContent).toContain('时间线:不可用'))
    expect(view.container.querySelector('[data-role="run-row"]')).not.toBeNull()
  })
})

describe('审批挂起与合并后确认影响服务', () => {
  it('显示待审批令牌提示(只读呈现 change C)', () => {
    const view = render(
      <RunPanel
        runs={[makeRun()]}
        approvals={[{ approvalId: 'ap-1', op: 'merge', scope: 'merge:task:t-1', expiresAt: 9_000_000_000 }]}
        streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream"
        pollMs={5_000}
        historyAvailable
      />,
    )
    const panel = expandFirstRun(view.container)
    const hint = panel.querySelector('[data-role="approval-pending"]') as HTMLElement
    expect(hint.textContent).toContain('待审批令牌')
    expect(hint.textContent).toContain('merge')
    // 审批决定仍在仪表盘面板做,看板只提示
    expect(hint.textContent).toContain('仪表盘审批面板')
  })

  it('已 merge 的 run 需用户勾选才把受影响服务候选写成关联', async () => {
    const onAssociate = vi.fn(async () => undefined)
    const run = makeRun({
      taskId: 't-1',
      state: 'merged',
      stateLabel: '已合并',
      merged: true,
      mergedAt: 5_000,
      serviceCandidates: [
        { refId: 'user-service', label: 'user-service', reason: '改动文件命中 /repos/user-service/src/login.ts' },
        { refId: 'order-service', label: 'order-service', reason: '改动文件命中 /repos/order-service/src/x.ts' },
      ],
    })
    const view = render(
      <RunPanel runs={[run]} approvals={[]} streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream" pollMs={5_000} historyAvailable onAssociate={onAssociate} />,
    )
    const panel = expandFirstRun(view.container)
    expect(panel.textContent).toContain('user-service')

    const boxes = panel.querySelectorAll('[data-role="candidate-check"]')
    expect(boxes.length).toBe(2)
    // 未勾选时点击不写入
    fireEvent.click(panel.querySelector('[data-role="confirm-candidates"]') as HTMLElement)
    expect(onAssociate).not.toHaveBeenCalled()

    fireEvent.click(boxes[0] as HTMLElement)
    fireEvent.click(panel.querySelector('[data-role="confirm-candidates"]') as HTMLElement)
    await waitFor(() => expect(onAssociate).toHaveBeenCalledWith({ type: 'service', refId: 'user-service', label: 'user-service' }))
  })
})

describe('无 run 的卡片', () => {
  it('显示空态而不是空面板', () => {
    const view = render(
      <RunPanel runs={[]} approvals={[]} streamUrlTemplate="/helmsman-dashboard/api/task/{taskId}/stream" pollMs={5_000} historyAvailable />,
    )
    expect(screen.getByText('该卡片尚无执行记录。')).toBeTruthy()
    expect(view.container.querySelector('[data-role="run-panel"]')).toBeNull()
  })
})
