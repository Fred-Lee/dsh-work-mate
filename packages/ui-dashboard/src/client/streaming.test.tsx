// @vitest-environment jsdom
/**
 * 流式回归测试：锁定「任务日志由 SSE 事件驱动追加、断线后按 cursor 重新
 * 同步、重连不重复」三条路径（D5 + execution-streaming spec）。用假
 * EventSource 驱动 App 的任务流，不发真实网络请求。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { StatePayload, TaskPayload } from './api'

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

  // ---- test helpers -------------------------------------------------------
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

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

function runningTaskPayload(): StatePayload {
  const now = Date.now()
  const task: TaskPayload = {
    id: 't1',
    prompt: '并行修改登录接口',
    status: 'RUNNING',
    projectGroupId: '订单中台',
    cascade: false,
    timeoutSec: 300,
    createdAt: now - 5000,
    endedAt: null,
    agents: {
      claude: {
        state: 'running',
        attempts: 1,
        startedAt: now - 2000,
        endedAt: null,
        exitCode: null,
        error: null,
        stats: null,
        conflictingFiles: [],
        hasDiff: false,
      },
      codex: {
        state: 'idle',
        attempts: 0,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        error: null,
        stats: null,
        conflictingFiles: [],
        hasDiff: false,
      },
    },
  }
  return {
    serverTime: now,
    groups: ['订单中台'],
    agents: { claude: { installed: true, version: '1.0' }, codex: { installed: true, version: '1.0' } },
    tasks: [task],
    usage: {},
  }
}

function stateEvent(seq: number): string {
  return JSON.stringify({
    v: 1,
    seq,
    ts: seq * 1000,
    taskId: 't1',
    kind: 'task-state',
    payload: {
      id: 't1',
      prompt: '并行修改登录接口',
      status: 'RUNNING',
      cascade: false,
      timeoutSec: 300,
      createdAt: Date.now() - 5000,
      agents: {
        claude: { agent: 'claude', state: 'running', attempts: 1, startedAt: Date.now() - 2000, hasDiff: false },
        codex: { agent: 'codex', state: 'idle', attempts: 0, hasDiff: false },
      },
    },
  })
}

function logEvent(seq: number, agent: string, text: string): string {
  return JSON.stringify({ v: 1, seq, ts: seq * 1000, taskId: 't1', kind: 'agent-log', agent, payload: { text } })
}

beforeEach(() => {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(runningTaskPayload())))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('任务 SSE 流（日志追加 + cursor 续传重连）', () => {
  it('流驱动日志追加：agent-log 事件实时进入日志面板', async () => {
    const view = render(<App />)
    // coarse poll loads the running task → App opens a stream for it
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    const es = FakeEventSource.instances[0]!
    expect(es.url).toContain('/task/t1/stream?after=0')

    act(() => {
      es.open()
      es.message(stateEvent(1))
      es.message(logEvent(2, 'claude', 'claude: 开始修改登录接口\n'))
      es.message(logEvent(3, 'claude', 'claude: 单元测试通过 ✓\n'))
    })

    // open the first agent card (claude) log and see the streamed lines
    const cards = view.container.querySelectorAll('.agent-card')
    expect(cards.length).toBe(2)
    const claudeCard = cards[0] as HTMLElement
    const expand = [...claudeCard.querySelectorAll('button')].find((b) => b.textContent?.includes('展开日志'))
    expect(expand).toBeDefined()
    fireEvent.click(expand!)

    await waitFor(() => {
      const pre = claudeCard.querySelector('.card-log')
      expect(pre?.textContent).toContain('claude: 开始修改登录接口')
      expect(pre?.textContent).toContain('claude: 单元测试通过 ✓')
    })
  })

  it('断线后按最后 cursor 重连并重新同步，无重复', async () => {
    render(<App />)
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    const first = FakeEventSource.instances[0]!
    act(() => {
      first.open()
      first.message(stateEvent(1))
      first.message(logEvent(2, 'claude', 'line A\n'))
      first.message(logEvent(3, 'claude', 'line B\n'))
    })

    // network drop → manual reconnect must carry after=3 (last processed seq)
    act(() => first.error())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700)) // backoff 500ms
    })

    expect(FakeEventSource.instances.length).toBe(2)
    const second = FakeEventSource.instances[1]!
    expect(second.url).toContain('/task/t1/stream?after=3')
    expect(second.closed).toBe(false)

    // the resynced stream resumes at seq 4 — nothing before the cursor repeats
    act(() => {
      second.open()
      second.message(logEvent(4, 'claude', 'line C\n'))
    })

    const claudeCard = document.querySelectorAll('.agent-card')[0] as HTMLElement
    const expand = [...claudeCard.querySelectorAll('button')].find((b) => b.textContent?.includes('展开日志'))!
    fireEvent.click(expand)

    await waitFor(() => {
      const text = claudeCard.querySelector('.card-log')?.textContent ?? ''
      expect(text).toContain('line A')
      expect(text).toContain('line B')
      expect(text).toContain('line C')
      // A/B were only ever delivered before the reconnect; no duplicates
      expect(text.match(/line A/g)?.length).toBe(1)
      expect(text.match(/line B/g)?.length).toBe(1)
      expect(text.match(/line C/g)?.length).toBe(1)
    })
  })
})
