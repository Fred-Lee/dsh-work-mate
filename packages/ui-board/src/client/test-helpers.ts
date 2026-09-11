/**
 * Shared test doubles for the ui-board client tests (jsdom + @testing-library).
 * Not a test file itself — the vitest include pattern only picks `*.test.tsx`.
 */
import { vi } from 'vitest'
import type {
  BoardCardPayload,
  CardRunPayload,
  ConfigPayload,
  ItemDetailPayload,
  ItemsPayload,
  ResolvedAssociationPayload,
  RunsPayload,
  Stage,
  WipPayload,
} from './api'

export function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

export interface FetchCall {
  url: string
  init?: RequestInit
  body: Record<string, unknown> | null
}

/**
 * Installs a fetch stub that routes by URL. The handler returns the JSON body
 * for a request; every call is recorded for assertions.
 */
export function installFetch(
  handler: (url: string, init?: RequestInit, body?: Record<string, unknown> | null) => unknown | Promise<unknown>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      let body: Record<string, unknown> | null = null
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>
        } catch {
          body = null
        }
      }
      calls.push({ url, ...(init ? { init } : {}), body })
      return jsonResponse(await handler(url, init, body))
    }),
  )
  return { calls }
}

export function makeCard(overrides: Partial<BoardCardPayload> = {}): BoardCardPayload {
  const stage: Stage = overrides.stage ?? 'spec'
  return {
    id: 'wi-1',
    title: '登录接口并行改造',
    stage,
    stageLabel: { requirements: '需求分析', spec: '规格设计', dev: '开发实施', done: '验收归档' }[stage],
    repo: 'order-core',
    projectGroup: '订单中台',
    repoScope: { baseRepo: 'order-core', projectGroup: '订单中台' },
    module: null,
    conflictDomain: 'order-core:*',
    summary: { text: '重构登录接口并补充单测,涉及 3 个服务。', generatedBy: 'model', at: 1_500 },
    badges: { docs: 2, conversations: 1, services: 1 },
    runState: 'idle',
    runStateLabel: '无执行',
    runCount: 0,
    queueingReason: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

export function makeConfig(overrides: Partial<ConfigPayload> = {}): ConfigPayload {
  return {
    mountPath: '/helmsman-board',
    dashboardMount: '/helmsman-dashboard',
    diffMount: '/helmsman-diff',
    workbenchMount: '/helmsman-workbench',
    pollMs: 5_000,
    streamUrlTemplate: '/helmsman-dashboard/api/task/{taskId}/stream',
    services: { board: true, orchestrator: true, artifacts: true, topology: false },
    ...overrides,
  }
}

export function makeWip(overrides: Partial<WipPayload> = {}): WipPayload {
  return {
    source: 'service',
    policy: { moduleLimit: 1, repoFallbackLimit: 2 },
    domains: [],
    ...overrides,
  }
}

export function makeItemsPayload(cards: BoardCardPayload[], overrides: Partial<ItemsPayload> = {}): ItemsPayload {
  return {
    serverTime: 1,
    items: cards,
    itemCount: cards.length,
    columns: (['requirements', 'spec', 'dev', 'done'] as Stage[]).map((stage) => ({
      stage,
      label: { requirements: '需求分析', spec: '规格设计', dev: '开发实施', done: '验收归档' }[stage],
      count: cards.filter((c) => c.stage === stage).length,
    })),
    repos: [...new Set(cards.map((c) => c.repo))].sort(),
    wip: makeWip(),
    config: makeConfig(),
    ...overrides,
  }
}

export function makeAssociation(overrides: Partial<ResolvedAssociationPayload> = {}): ResolvedAssociationPayload {
  return {
    type: 'doc',
    refId: 'drafts/d-1.md',
    label: 'PRD 登录',
    at: 10,
    kind: 'workbench-doc',
    href: '/helmsman-workbench/?draft=drafts%2Fd-1.md',
    dangling: false,
    ...overrides,
  }
}

export function makeDetail(overrides: Partial<ItemDetailPayload> = {}): ItemDetailPayload {
  const card = overrides.item ?? makeCard()
  return {
    ok: true,
    item: card,
    nextStage: 'dev',
    nextStageLabel: '开发实施',
    gate: { to: 'dev', ok: false, gaps: [{ key: 'spec-finalized', label: '缺少已定稿 spec', action: '/helmsman-workbench/?draft=d-1' }] },
    associations: [makeAssociation()],
    services: makeConfig().services,
    ...overrides,
  }
}

export function makeRun(overrides: Partial<CardRunPayload> = {}): CardRunPayload {
  return {
    taskId: 't-1',
    startedAt: 3_000,
    terminal: null,
    state: 'running',
    stateLabel: '在跑',
    statusText: 'RUNNING',
    prompt: '并行修改登录接口',
    projectGroup: '订单中台',
    agents: { claude: { state: 'running', attempts: 1, conflictingFiles: [] } },
    conflicts: [],
    merged: false,
    mergedAt: null,
    mergedFiles: [],
    serviceCandidates: [],
    ...overrides,
  }
}

export function makeRuns(runs: CardRunPayload[], overrides: Partial<RunsPayload> = {}): RunsPayload {
  return {
    ok: true,
    itemId: 'wi-1',
    runs,
    approvals: [],
    historyAvailable: true,
    streamUrlTemplate: '/helmsman-dashboard/api/task/{taskId}/stream',
    pollMs: 5_000,
    diffMount: '/helmsman-diff',
    ...overrides,
  }
}
