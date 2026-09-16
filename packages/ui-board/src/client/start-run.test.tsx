// @vitest-environment jsdom
/**
 * 第 ③ 列「▶ 发起执行」integration tests (jsdom + @testing-library), locking the
 * spec `card-start-run`:
 *  1. 入口 gating:有 projectGroup + 至少一个已装 agent 才有按钮,否则是引导
 *  2. 对话框预填:标题 / 摘要骨架(无摘要则空)/ 级联默认勾上
 *  3. 三档 agent 控件:默认"按场景自适应"(拆解→claude、并行→codex、简单→最快已装)
 *  4. 手动改选原样提交,不回退
 *  5. 提交只调既有 runParallelTask 通路(一个 POST),卡片原地不动
 *  6. 只给「去执行看板」链接,不复制取消/重试/审批/合并
 */
import { cleanup, configure, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardView } from './App'
import { installFetch, makeCard, makeDetail, makeItemsPayload, makeRuns, makeStartRun, makeWip } from './test-helpers'
import type { BoardCardPayload } from './api'

configure({ asyncUtilTimeout: 5_000 })

let fetchCalls: ReturnType<typeof installFetch>['calls']

/** Dev-column fixtures: two startable cards with different scenario shapes, a
 *  codex-only group, and a card that fails the gate. */
function cards(): BoardCardPayload[] {
  const noSummary = { summary: null, badges: { docs: 0, conversations: 0, services: 0 } }
  return [
    makeCard({
      id: 'wi-decompose',
      title: '结算模块拆分',
      stage: 'dev',
      module: 'a',
      conflictDomain: 'order-core:a',
      ...noSummary,
    }),
    makeCard({
      id: 'wi-parallel',
      title: '报表导出并行改造',
      stage: 'dev',
      module: 'b',
      conflictDomain: 'order-core:b',
      ...noSummary,
    }),
    makeCard({
      id: 'wi-plain',
      title: '补充注释',
      stage: 'dev',
      module: 'c',
      conflictDomain: 'order-core:c',
      summary: { text: '给 utils 加注释。', generatedBy: 'manual', at: 1 },
    }),
    makeCard({
      id: 'wi-codex-only',
      title: '结算模块拆分 v2',
      stage: 'dev',
      module: 'd',
      conflictDomain: 'order-core:d',
      startRun: makeStartRun({ installed: ['codex'] }),
      ...noSummary,
    }),
    makeCard({
      id: 'wi-no-group',
      title: '游离卡片',
      stage: 'dev',
      module: 'e',
      conflictDomain: 'pay-core:e',
      repoScope: { baseRepo: 'pay-core' },
      projectGroup: null,
      startRun: makeStartRun({ available: false, reason: '卡片未配置项目群(projectGroup)', projectGroup: null }),
      ...noSummary,
    }),
    makeCard({ id: 'wi-spec', title: '需求梳理', stage: 'spec', ...noSummary }),
  ]
}

function stubApi(runResponse: unknown = { ok: true, taskId: 't-started' }): void {
  const fixture = cards()
  const { calls } = installFetch((url, init, body) => {
    if (url.includes('/api/items')) return makeItemsPayload(fixture, { wip: makeWip({ domains: [] }) })
    if (url.includes('/api/board/events')) return { events: [], available: false }
    if (url.includes('/api/board/wip')) return makeWip({ domains: [] })
    if (/\/api\/item\/[^/]+\/runs/.test(url)) return makeRuns([])
    if (/\/api\/item\/[^/]+\/run$/.test(url)) return runResponse
    if (/\/api\/item\/[^/]+$/.test(url)) return makeDetail({ item: fixture[0]!, associations: [] })
    if (init?.method === 'PATCH' || url.includes('/advance')) return { ok: false }
    void body
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

function card(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-id="${id}"]`)
  expect(el, `card ${id}`).not.toBeNull()
  return el as HTMLElement
}

async function openDialog(view: ReturnType<typeof render>, id: string): Promise<HTMLElement> {
  await waitFor(() => expect(view.container.querySelector(`[data-id="${id}"]`)).not.toBeNull())
  fireEvent.click(within(card(view.container, id)).getByRole('button', { name: /发起执行/ }))
  await waitFor(() => expect(view.container.querySelector('[data-role="start-run-form"]')).not.toBeNull())
  return view.container.querySelector('[data-role="start-run-form"]') as HTMLElement
}

function runCalls(): ReturnType<typeof installFetch>['calls'] {
  return fetchCalls.filter((call) => /\/api\/item\/[^/]+\/run$/.test(call.url))
}

describe('第 ③ 列发起执行入口(gating)', () => {
  it('有 projectGroup 且该群至少一个已装 agent 的 dev 卡片渲染「▶ 发起执行」', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(6))

    for (const id of ['wi-decompose', 'wi-parallel', 'wi-plain', 'wi-codex-only']) {
      const button = card(view.container, id).querySelector('[data-role="start-run"]')
      expect(button, id).not.toBeNull()
      expect(button!.textContent).toContain('发起执行')
    }
  })

  it('缺少 projectGroup 的卡片不渲染按钮,渲染「请先在执行看板发起」引导 + 原因', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(6))

    const blocked = card(view.container, 'wi-no-group')
    expect(blocked.querySelector('[data-role="start-run"]')).toBeNull()
    expect(blocked.querySelector('[data-role="start-run-hint"]')?.textContent).toContain('请先在执行看板发起')
    expect(blocked.querySelector('[data-role="start-run-hint-reason"]')?.textContent).toContain('projectGroup')
  })

  it('入口只在第 ③ 列;其它列的卡片没有该入口', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(6))

    const spec = card(view.container, 'wi-spec')
    expect(spec.querySelector('[data-role="start-run"]')).toBeNull()
    expect(spec.querySelector('[data-role="start-run-hint"]')).toBeNull()
    expect(spec.querySelector('[data-role="start-run"]')).toBeNull()
  })

  it('点入口打开对话框而不打开卡片抽屉(卡片自身的点击不会被触发)', async () => {
    const view = render(<BoardView />)
    await openDialog(view, 'wi-decompose')
    expect(window.location.search).not.toContain('card=wi-decompose')
  })
})

describe('发起对话框:预填与级联开关', () => {
  it('标题预填卡片标题、提示词骨架预填卡片 summary、级联默认勾上', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-plain')

    expect((dialog.querySelector('[data-role="start-run-title"]') as HTMLInputElement).value).toBe('补充注释')
    expect((dialog.querySelector('[data-role="start-run-prompt"]') as HTMLTextAreaElement).value).toBe('给 utils 加注释。')
    expect((dialog.querySelector('[data-role="start-run-cascade"]') as HTMLInputElement).checked).toBe(true)
    // 提交的提示词 = 标题 + 摘要骨架
    expect(dialog.querySelector('[data-role="start-run-prompt-preview"]')?.textContent).toBe('补充注释\n\n给 utils 加注释。')
  })

  it('无 summary 时提示词骨架为空 textarea(标题仍在)', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-decompose')

    expect((dialog.querySelector('[data-role="start-run-prompt"]') as HTMLTextAreaElement).value).toBe('')
    expect((dialog.querySelector('[data-role="start-run-title"]') as HTMLInputElement).value).toBe('结算模块拆分')
    expect(dialog.querySelector('[data-role="start-run-prompt-preview"]')?.textContent).toBe('结算模块拆分')
  })

  it('标题与骨架都可改,改后即为提交的提示词', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-plain')
    fireEvent.change(dialog.querySelector('[data-role="start-run-title"]') as HTMLInputElement, { target: { value: '改过的标题' } })
    fireEvent.change(dialog.querySelector('[data-role="start-run-prompt"]') as HTMLTextAreaElement, { target: { value: '改过的骨架' } })

    fireEvent.click(dialog.querySelector('[data-role="start-run-submit"]') as HTMLElement)
    await waitFor(() => expect(runCalls().length).toBe(1))
    expect(runCalls()[0]!.body).toMatchObject({ prompt: '改过的标题\n\n改过的骨架' })
  })
})

describe('发起对话框:agent 三档与按场景默认', () => {
  it('控件是「按场景自适应(默认)/ claude / codex」三档且默认 auto', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-decompose')
    const select = dialog.querySelector('[data-role="start-run-agent"]') as HTMLSelectElement

    expect([...select.options].map((option) => option.textContent)).toEqual(['按场景自适应(默认)', 'claude', 'codex'])
    expect(select.value).toBe('auto')
  })

  it('拆解/计划型 → claude;并行型 → codex;简单型 → 最快已装(claude 优先)', async () => {
    const view = render(<BoardView />)

    const decompose = await openDialog(view, 'wi-decompose')
    expect(decompose.querySelector('[data-role="start-run-resolved"]')?.textContent).toContain('→ claude')
    cleanup()

    stubApi()
    const second = render(<BoardView />)
    const parallel = await openDialog(second, 'wi-parallel')
    expect(parallel.querySelector('[data-role="start-run-resolved"]')?.textContent).toContain('→ codex')
    cleanup()

    stubApi()
    const third = render(<BoardView />)
    const plain = await openDialog(third, 'wi-plain')
    expect(plain.querySelector('[data-role="start-run-resolved"]')?.textContent).toContain('简单/单步任务 → claude')
  })

  it('只装了 codex 时,拆解型任务退回最快已装并说明(近似规则透明可见)', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-codex-only')
    const resolved = dialog.querySelector('[data-role="start-run-resolved"]')?.textContent ?? ''

    expect(resolved).toContain('将使用:codex')
    expect(resolved).toContain('未安装')
    expect(dialog.querySelector('[data-role="start-run-installed"]')?.textContent).toContain('已装 agent:codex')
  })

  it('手动改选为 codex 后原样提交,系统不再回退到自适应', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-decompose')
    // 默认是 claude(拆解型)
    expect(dialog.querySelector('[data-role="start-run-resolved"]')?.textContent).toContain('→ claude')

    fireEvent.change(dialog.querySelector('[data-role="start-run-agent"]') as HTMLSelectElement, { target: { value: 'codex' } })
    expect(dialog.querySelector('[data-role="start-run-resolved"]')?.textContent).toContain('已手动指定 codex')

    fireEvent.click(dialog.querySelector('[data-role="start-run-submit"]') as HTMLElement)
    await waitFor(() => expect(runCalls().length).toBe(1))
    expect(runCalls()[0]!.body).toMatchObject({ agents: ['codex'] })
  })
})

describe('提交:走既有 runParallelTask,卡片原地不动', () => {
  it('只发一个 run 请求,body 恰为 prompt/agents/cascade(项目组由服务端按卡片解析)', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-decompose')
    fireEvent.click(dialog.querySelector('[data-role="start-run-submit"]') as HTMLElement)

    await waitFor(() => expect(runCalls().length).toBe(1))
    const call = runCalls()[0]!
    expect(call.url).toBe('/helmsman-board/api/item/wi-decompose/run')
    expect(call.init?.method).toBe('POST')
    expect(Object.keys(call.body ?? {}).sort()).toEqual(['agents', 'cascade', 'prompt'])
    expect(call.body).toEqual({ prompt: '结算模块拆分', agents: ['claude'], cascade: true })
  })

  it('取消勾选级联则 cascade:false(其余不变)', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-decompose')
    fireEvent.click(dialog.querySelector('[data-role="start-run-cascade"]') as HTMLInputElement)
    fireEvent.click(dialog.querySelector('[data-role="start-run-submit"]') as HTMLElement)

    await waitFor(() => expect(runCalls().length).toBe(1))
    expect(runCalls()[0]!.body).toEqual({ prompt: '结算模块拆分', agents: ['claude'], cascade: false })
  })

  it('起跑后卡片不移动:没有 advance / PATCH 调用,卡片仍在第 ③ 列', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-decompose')
    fireEvent.click(dialog.querySelector('[data-role="start-run-submit"]') as HTMLElement)

    await waitFor(() => expect(dialog.querySelector('[data-role="start-run-started"]')?.textContent).toContain('t-started'))
    // 没有第二个写通道:既没有推进,也没有 PATCH 卡片
    expect(fetchCalls.some((call) => call.url.includes('/advance'))).toBe(false)
    expect(fetchCalls.some((call) => call.init?.method === 'PATCH')).toBe(false)
    // 卡片原地不动(服务端仍是权威:重新拉取后仍在 dev 列)
    const dev = view.container.querySelector('[data-role="column"][data-stage="dev"]') as HTMLElement
    expect(within(dev).getByText('结算模块拆分')).toBeTruthy()
    expect(card(view.container, 'wi-decompose').getAttribute('data-stage')).toBe('dev')
    // 报告成功并提供卡片时间线入口
    expect(dialog.querySelector('[data-role="start-run-done"]')).not.toBeNull()
    expect(dialog.querySelector('[data-role="start-run-open-card"]')).not.toBeNull()
  })

  it('服务端拒绝(ok:false)时显示原因,不显示成功', async () => {
    stubApi({ ok: false, reason: '该项目群暂无已安装的 agent,请先在执行看板发起' })
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-decompose')
    fireEvent.click(dialog.querySelector('[data-role="start-run-submit"]') as HTMLElement)

    await waitFor(() =>
      expect(dialog.querySelector('[data-role="start-run-error"]')?.textContent).toContain('该项目群暂无已安装的 agent'),
    )
    expect(dialog.querySelector('[data-role="start-run-done"]')).toBeNull()
  })

  it('手动指定一个未装的 agent:如实提示并禁用提交,不静默替换成别的 agent', async () => {
    const view = render(<BoardView />)
    const dialog = await openDialog(view, 'wi-codex-only') // 只装了 codex
    fireEvent.change(dialog.querySelector('[data-role="start-run-agent"]') as HTMLSelectElement, { target: { value: 'claude' } })

    expect(dialog.querySelector('[data-role="start-run-agent-warning"]')?.textContent).toContain('claude 未安装')
    expect((dialog.querySelector('[data-role="start-run-submit"]') as HTMLButtonElement).disabled).toBe(true)
    expect((dialog.querySelector('[data-role="start-run-resolved"]')?.textContent ?? '')).toContain('将使用:claude')
    expect(runCalls().length).toBe(0)
  })
})

describe('操作边界:只有「去执行看板」链接', () => {
  it('卡片与对话框都提供跳转执行看板的链接,不出现取消/重试/审批/合并控件', async () => {
    const view = render(<BoardView />)
    await waitFor(() => expect(view.container.querySelectorAll('[data-role="card"]').length).toBe(6))

    const link = card(view.container, 'wi-decompose').querySelector('[data-role="start-run-dashboard-link"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/helmsman-dashboard/')
    expect(link.textContent).toContain('去执行看板')

    const dialog = await openDialog(view, 'wi-decompose')
    const dialogLink = dialog.querySelector('[data-role="start-run-dashboard"]') as HTMLAnchorElement
    expect(dialogLink.getAttribute('href')).toBe('/helmsman-dashboard/')

    // 复制操作面板的证据:整个页面没有任何 run 生命周期控件
    for (const role of ['run-cancel', 'run-retry', 'run-merge', 'run-approve', 'run-approval', 'start-run-cancel']) {
      expect(view.container.querySelector(`[data-role="${role}"]`), role).toBeNull()
    }
  })
})
