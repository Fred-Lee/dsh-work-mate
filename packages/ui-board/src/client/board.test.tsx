// @vitest-environment jsdom
/**
 * Board view component tests (jsdom + @testing-library) — mirrors the
 * ui-dashboard client-test conventions.
 *
 * Locked behaviours (spec task-kanban):
 *  1. 四列 + 列头计数 + 第 ③ 列 在跑/上限
 *  2. 卡片摘要 / 角标 / run 状态点 / 排队置灰
 *  3. 筛选与 URL query 双向同步(?repo=&stage=&card=)
 *  4. 抽屉推进门缺口(未满足置灰,按钮禁用)
 *  5. 拖拽 = 调用推进接口,卡片不本地移动
 *  6. 建档表单
 */
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardView } from './App'
import { installFetch, makeCard, makeDetail, makeItemsPayload, makeRuns, makeWip } from './test-helpers'
import type { AdvancePayload } from './api'

const APPROVED: AdvancePayload = { ok: true, from: 'spec', to: 'dev', moved: true, gaps: [] }

let fetchCalls: ReturnType<typeof installFetch>['calls']

// Generous retry window: the view fetches twice per interaction (grid + drawer)
// and the suite must stay stable on a loaded machine.
configure({ asyncUtilTimeout: 5_000 })

/** Default fixture: one spec card (with summary/badges), two dev cards in two
 *  conflict domains of the SAME repo, and one queued card refused entry. */
function defaultCards() {
  return [
    makeCard({ id: 'wi-1', title: '登录接口并行改造', stage: 'spec', runState: 'running', runStateLabel: '在跑', runCount: 1 }),
    makeCard({
      id: 'wi-2',
      title: '结算模块拆分',
      stage: 'dev',
      module: 'a',
      conflictDomain: 'order-core:a',
      summary: null,
      badges: { docs: 0, conversations: 0, services: 0 },
    }),
    makeCard({ id: 'wi-3', title: '报表导出', stage: 'dev', module: 'b', conflictDomain: 'order-core:b', summary: null, badges: { docs: 0, conversations: 0, services: 0 } }),
    makeCard({
      id: 'wi-4',
      title: '支付对账',
      stage: 'spec',
      repo: 'pay-core',
      repoScope: { baseRepo: 'pay-core' },
      queueingReason: '冲突域 pay-core:a 已达上限',
      runState: 'queued',
      runStateLabel: '排队',
      summary: null,
      badges: { docs: 0, conversations: 0, services: 0 },
    }),
  ]
}

function stubApi(overrides: { advance?: AdvancePayload } = {}): void {
  const cards = defaultCards()
  const detail = makeDetail({ item: cards[0]! })
  const { calls } = installFetch((url) => {
    const wip = makeWip({
      domains: [
        { key: 'order-core:a', repo: 'order-core', module: 'a', running: 1, limit: 1, itemIds: ['wi-2'] },
        { key: 'order-core:b', repo: 'order-core', module: 'b', running: 1, limit: 1, itemIds: ['wi-3'] },
      ],
    })
    if (url.includes('/api/items')) return makeItemsPayload(cards, { wip })
    if (url.includes('/api/board/wip')) return wip
    if (url.includes('/api/board/events')) return { events: [{ ts: 111, from: 'requirements', to: 'spec', actor: 'ui' }], available: true }
    if (/\/api\/item\/[^/]+\/runs/.test(url)) return makeRuns([])
    if (/\/api\/item\/[^/]+\/advance/.test(url)) return overrides.advance ?? APPROVED
    if (/\/api\/item\/[^/]+$/.test(url)) return detail
    if (url.includes('/api/item')) return { ok: true, item: cards[0]! }
    return {}
  })
  fetchCalls = calls
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  stubApi()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function column(container: HTMLElement, stage: string): HTMLElement {
  const el = container.querySelector(`[data-role="column"][data-stage="${stage}"]`)
  expect(el).not.toBeNull()
  return el as HTMLElement
}

describe('看板四列与卡片', () => {
  it('渲染四列并显示中文阶段标题与卡片计数', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))

    const titles = [...view.container.querySelectorAll('.column-title')].map((el) => el.textContent)
    expect(titles).toEqual(['需求分析', '规格设计', '开发实施', '验收归档'])

    const counts = [...view.container.querySelectorAll('[data-role="column-count"]')].map((el) => `${el.getAttribute('data-stage')}:${el.textContent}`)
    expect(counts).toEqual(['requirements:0', 'spec:2', 'dev:2', 'done:0'])

    // 每张卡片落在其阶段列
    expect(within(column(view.container, 'spec')).getByText('登录接口并行改造')).toBeTruthy()
    expect(within(column(view.container, 'dev')).getByText('结算模块拆分')).toBeTruthy()
    expect(within(column(view.container, 'done')).queryByText('登录接口并行改造')).toBeNull()
  })

  it('卡片直接展示摘要、角标与 run 状态点', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    const card = view.container.querySelector('[data-id="wi-1"]') as HTMLElement

    expect(card.querySelector('[data-role="card-summary"]')?.textContent).toContain('重构登录接口并补充单测')
    expect(card.querySelector('[data-role="badge-doc"]')?.textContent).toContain('2')
    expect(card.querySelector('[data-role="badge-conversation"]')?.textContent).toContain('1')
    expect(card.querySelector('[data-role="badge-service"]')?.textContent).toContain('1')
    expect(card.querySelector('[data-role="run-dot"]')?.getAttribute('data-state')).toBe('running')
    expect(within(card).getByText('在跑')).toBeTruthy()
  })

  it('第 ③ 列显示各冲突域 在跑/上限,同仓不同模块各自成组', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    const dev = column(view.container, 'dev')

    const domains = [...dev.querySelectorAll('[data-role="wip-domain"]')].map((el) => `${el.getAttribute('data-key')} ${el.textContent}`)
    expect(domains).toContain('order-core:a order-core:a 1/1')
    expect(domains).toContain('order-core:b order-core:b 1/1')
    expect(dev.querySelector('[data-role="dev-wip"]')?.textContent).toContain('在跑 2/2')
    // 两张同仓不同模块的卡都在开发列、互不计数
    expect(dev.querySelectorAll('[data-role="card"]').length).toBe(2)
  })

  it('被拒卡片显示排队原因并置灰,仍留在原列', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    const spec = column(view.container, 'spec')
    const queued = spec.querySelector('[data-id="wi-4"]') as HTMLElement
    expect(queued.className).toContain('is-queued')
    expect(queued.querySelector('[data-role="card-queue"]')?.textContent).toContain('冲突域 pay-core:a 已达上限')
    expect(queued.querySelector('[data-role="run-dot"]')?.getAttribute('data-state')).toBe('queued')
  })
})

describe('筛选与 URL 状态', () => {
  it('按仓库筛选后只显示该仓库卡片且列计数更新', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))

    fireEvent.change(view.container.querySelector('[data-role="filter-repo"]') as HTMLSelectElement, { target: { value: 'pay-core' } })

    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(1))
    expect(screen.getByText('支付对账')).toBeTruthy()
    const counts = [...view.container.querySelectorAll('[data-role="column-count"]')].map((el) => el.textContent)
    expect(counts).toEqual(['0', '1', '0', '0'])
    expect(window.location.search).toContain('repo=pay-core')
  })

  it('仅看无对话摘要的筛选生效', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.change(view.container.querySelector('[data-role="filter-summary"]') as HTMLSelectElement, { target: { value: 'none' } })
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(3))
    expect(window.location.search).toContain('summary=none')
  })

  it('刷新时按 URL query 还原筛选与打开的抽屉(?repo=&stage=&card=)', async () => {
    window.history.replaceState(null, '', '/?repo=order-core&stage=dev&card=wi-2')
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(2))

    expect((view.container.querySelector('[data-role="filter-repo"]') as HTMLSelectElement).value).toBe('order-core')
    expect((view.container.querySelector('[data-role="filter-stage"]') as HTMLSelectElement).value).toBe('dev')
    // 抽屉按 query 自动打开
    await waitFor(() => expect(view.container.querySelector('[data-role="drawer"]')).not.toBeNull())
    expect(view.container.querySelector('.drawer-title')?.textContent).toBe('登录接口并行改造')
  })

  it('点击卡片把 card id 写入 URL,关闭后移除', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.click(view.container.querySelector('[data-id="wi-1"]') as HTMLElement)
    await waitFor(() => expect(window.location.search).toContain('card=wi-1'))
    fireEvent.click(view.container.querySelector('[data-role="drawer-close"]') as HTMLElement)
    await waitFor(() => expect(window.location.search).not.toContain('card=wi-1'))
  })
})

describe('详情抽屉与推进门', () => {
  it('列出未满足门项、禁用推进按钮,并提供补齐跳转入口', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.click(view.container.querySelector('[data-id="wi-1"]') as HTMLElement)

    await waitFor(() => expect(view.container.querySelector('[data-role="gate-list"]')).not.toBeNull())
    const gap = view.container.querySelector('[data-role="gate-gap"]') as HTMLElement
    expect(gap.textContent).toContain('缺少已定稿 spec')
    expect((view.container.querySelector('[data-role="advance"]') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(gap).getByRole('button'))
    expect(open).toHaveBeenCalledWith('/helmsman-workbench/?draft=d-1', '_blank', 'noreferrer')
  })

  it('展示可编辑摘要、冲突域与关联分区跳转(不复制内容)', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.click(view.container.querySelector('[data-id="wi-1"]') as HTMLElement)
    await waitFor(() => expect(view.container.querySelector('[data-role="drawer"]')).not.toBeNull())

    expect((view.container.querySelector('[data-role="summary-input"]') as HTMLTextAreaElement).value).toContain('重构登录接口')
    expect(view.container.querySelector('[data-role="module-domain"]')?.textContent).toContain('order-core:')

    // 六个关联分区都在,跳转是链接(href 指向对应工具),不渲染目标内容
    const groups = [...view.container.querySelectorAll('[data-role="assoc-group"]')].map((el) => el.getAttribute('data-type'))
    expect(groups).toEqual(['doc', 'conversation', 'service', 'worktree', 'run', 'artifact'])
    const jump = view.container.querySelector('[data-role="assoc-jump"]') as HTMLAnchorElement
    expect(jump.getAttribute('href')).toBe('/helmsman-workbench/?draft=drafts%2Fd-1.md')
    expect(jump.getAttribute('target')).toBe('_blank')

    // 阶段迁移留痕来自 board 的 queryEvents
    expect(view.container.querySelector('[data-role="migration-list"]')?.textContent).toContain('requirements → spec')
  })

  it('保存摘要走 PATCH,保存开发作用域走 PATCH(module)', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.click(view.container.querySelector('[data-id="wi-1"]') as HTMLElement)
    await waitFor(() => expect(view.container.querySelector('[data-role="drawer"]')).not.toBeNull())

    fireEvent.change(view.container.querySelector('[data-role="summary-input"]') as HTMLTextAreaElement, { target: { value: '用户改写后的摘要' } })
    fireEvent.click(view.container.querySelector('[data-role="summary-save"]') as HTMLElement)
    fireEvent.change(view.container.querySelector('[data-role="module-input"]') as HTMLInputElement, { target: { value: 'payment' } })
    fireEvent.click(view.container.querySelector('[data-role="module-save"]') as HTMLElement)

    await waitFor(() => {
      const patch = fetchCalls.filter((call) => call.init?.method === 'PATCH')
      expect(patch.length).toBe(2)
      expect(patch[0]!.body).toEqual({ summary: { text: '用户改写后的摘要' } })
      expect(patch[1]!.body).toEqual({ module: 'payment' })
    })
  })
})

describe('推进交互(拖拽 / 按钮,均走推进接口)', () => {
  function dataTransfer(id: string) {
    return { setData: vi.fn(), getData: vi.fn(() => id), effectAllowed: 'move' }
  }

  it('拖到相邻列调用 advance 接口,卡片不本地移动', async () => {
    stubApi()
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))

    const card = view.container.querySelector('[data-id="wi-1"]') as HTMLElement
    const dev = column(view.container, 'dev')
    fireEvent.dragStart(card, { dataTransfer: dataTransfer('wi-1') })
    fireEvent.dragOver(dev, { dataTransfer: dataTransfer('wi-1') })
    fireEvent.drop(dev, { dataTransfer: dataTransfer('wi-1') })

    await waitFor(() => {
      const advance = fetchCalls.find((call) => call.url.includes('/item/wi-1/advance'))
      expect(advance).toBeDefined()
      expect(advance!.init?.method).toBe('POST')
      expect(advance!.body).toEqual({ to: 'dev' })
    })
    // 服务端仍是权威:列表里 wi-1 依然在 spec 列(没有任何本地移动)
    expect(within(column(view.container, 'spec')).getByText('登录接口并行改造')).toBeTruthy()
  })

  it('拖到非相邻列仍走同一接口(默认单步,越级由服务端拒绝)', async () => {
    stubApi({ advance: { ok: false, from: 'spec', to: 'done', moved: false, gaps: [{ key: 'stage-order', label: '缺失中间阶段' }] } })
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.dragStart(view.container.querySelector('[data-id="wi-1"]') as HTMLElement, { dataTransfer: dataTransfer('wi-1') })
    fireEvent.drop(column(view.container, 'done'), { dataTransfer: dataTransfer('wi-1') })

    await waitFor(() => {
      const advance = fetchCalls.find((call) => call.url.includes('/item/wi-1/advance'))
      expect(advance!.body).toEqual({ to: 'done' })
    })
  })

  it('推进被拒时显示缺口与原因,卡片留在原列并置灰', async () => {
    stubApi({
      advance: {
        ok: false,
        from: 'spec',
        to: 'dev',
        moved: false,
        gaps: [{ key: 'spec-finalized', label: '缺少已定稿 spec' }],
        queueingReason: '冲突域 order-core:* 已满',
      },
    })
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.dragStart(view.container.querySelector('[data-id="wi-1"]') as HTMLElement, { dataTransfer: dataTransfer('wi-1') })
    fireEvent.drop(column(view.container, 'dev'), { dataTransfer: dataTransfer('wi-1') })

    await waitFor(() => expect(view.container.querySelector('[data-role="toast"]')?.textContent).toContain('冲突域 order-core:* 已满'))
    const card = view.container.querySelector('[data-id="wi-1"]') as HTMLElement
    expect(card.className).toContain('is-queued')
    expect(card.querySelector('[data-role="card-queue"]')?.textContent).toContain('排队')
    expect(within(column(view.container, 'spec')).getByText('登录接口并行改造')).toBeTruthy()
  })

  it('抽屉的推进按钮走同一个 advance 接口', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.click(view.container.querySelector('[data-id="wi-1"]') as HTMLElement)
    await waitFor(() => expect(view.container.querySelector('[data-role="advance"]')).not.toBeNull())

    // 门项未满足 → 按钮禁用(规格:未满足项置灰)
    expect((view.container.querySelector('[data-role="advance"]') as HTMLButtonElement).disabled).toBe(true)

    // 门项满足时按钮可用并调用推进接口
    cleanup()
    stubApi()
    fetchCalls = installFetch((url) => {
      if (url.includes('/api/items')) return makeItemsPayload(defaultCards())
      if (url.includes('/api/board/events')) return { events: [], available: false }
      if (/\/api\/item\/[^/]+\/runs/.test(url)) return makeRuns([])
      if (/\/api\/item\/[^/]+\/advance/.test(url)) return APPROVED
      if (/\/api\/item\/[^/]+$/.test(url)) {
        return makeDetail({ item: defaultCards()[0]!, gate: { to: 'dev', ok: true, gaps: [] } })
      }
      return {}
    }).calls
    const second = render(<BoardView />)
    await waitFor(() => expect(second.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.click(second.container.querySelector('[data-id="wi-1"]') as HTMLElement)
    await waitFor(() => expect(second.container.querySelector('[data-role="gate-ok"]')).not.toBeNull())
    const button = second.container.querySelector('[data-role="advance"]') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(fetchCalls.some((call) => call.url.includes('/item/wi-1/advance'))).toBe(true))
  })
})

describe('建档入口', () => {
  it('校验必填项并调用 create', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(4))
    fireEvent.click(view.container.querySelector('[data-role="open-create"]') as HTMLElement)

    fireEvent.click(view.container.querySelector('[data-role="create-submit"]') as HTMLElement)
    await waitFor(() => expect(view.container.querySelector('[data-role="create-error"]')?.textContent).toContain('标题不能为空'))

    fireEvent.change(view.container.querySelector('[data-role="create-title"]') as HTMLInputElement, { target: { value: '新的结算需求' } })
    fireEvent.change(view.container.querySelector('[data-role="create-repo"]') as HTMLInputElement, { target: { value: 'order-core' } })
    fireEvent.click(view.container.querySelector('[data-role="create-doc-preset"]') as HTMLInputElement)
    fireEvent.click(view.container.querySelector('[data-role="create-submit"]') as HTMLElement)

    await waitFor(() => {
      const create = fetchCalls.find((call) => call.url.endsWith('/api/item'))
      expect(create).toBeDefined()
      expect(create!.body).toEqual({
        title: '新的结算需求',
        repoScope: { baseRepo: 'order-core' },
        stage: 'requirements',
        docPreset: true,
      })
    })
    // 创建成功提供"打开卡片"
    await waitFor(() => expect(view.container.querySelector('[data-role="open-created"]')).not.toBeNull())
  })
})
