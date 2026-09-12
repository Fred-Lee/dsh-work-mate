// @vitest-environment jsdom
// ConfigPanel 回归测试：锁定「父组件轮询重渲染不得覆盖未保存编辑」与
// 「dirty 时关闭/切群需确认」两个行为。
// 背景: 曾因 useEffect 依赖含整个 props 对象, App 每 5s/1.5s 轮询 dispatch loaded
// 触发 effect 重跑, loadTopology 用服务端值覆盖编辑中的 topology。
// 另含 simplify-service-dependencies 的行为锁定：只选两个下拉即可录入服务级边、
// 同一对服务只占一行、无明细行渲染降级、保存后的图体检告警条。
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigPanel } from './App'
import type { GraphHealthPayload, TopologyPayload } from './api'

const toast = vi.fn()
const onClose = vi.fn()
const onSelectGroup = vi.fn()

const topology: TopologyPayload = {
  projectGroupId: 'demo',
  name: 'demo 群',
  description: '',
  defaultBranch: 'main',
  projects: {},
  services: {
    'user-service': {
      name: 'user-service',
      projectId: 'user-service',
      techStack: ['Java'],
      apiEndpoints: [],
      localPath: '/tmp/user-service',
    },
  },
  mavenParents: {},
  restDependencies: {},
}

/** 最小场景：两个服务、零依赖（spec: 单对服务只占一行）。 */
const twoServices: TopologyPayload = {
  ...topology,
  services: {
    'user-service': { name: 'user-service', projectId: 'user-service', techStack: [], apiEndpoints: [], localPath: '/tmp/user-service' },
    'order-service': { name: 'order-service', projectId: 'order-service', techStack: [], apiEndpoints: [], localPath: '/tmp/order-service' },
  },
}

const cleanHealth: GraphHealthPayload = { cyclic: false, cycles: [], dangling: [], isolated: [] }

let topologyFetches = 0
let topologyFixture: TopologyPayload = topology
let healthFixture: GraphHealthPayload | null = cleanHealth

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

beforeEach(() => {
  topologyFetches = 0
  topologyFixture = topology
  healthFixture = cleanHealth
  toast.mockClear()
  onClose.mockClear()
  onSelectGroup.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/topology?')) {
      topologyFetches++
      return jsonResponse({ group: 'demo', topology: topologyFixture })
    }
    if (url.includes('/api/topology/health')) {
      return jsonResponse({ group: 'demo', health: healthFixture, available: true })
    }
    return jsonResponse({ ok: true })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderPanel(groups: string[] = ['demo', 'other']): ReturnType<typeof render> {
  return render(
    <ConfigPanel
      groups={groups}
      currentGroup="demo"
      onClose={onClose}
      onSelectGroup={onSelectGroup}
      onToast={toast}
    />,
  )
}

describe('ConfigPanel 轮询与 dirty 保护', () => {
  it('父组件轮询重渲染不覆盖未保存的编辑', async () => {
    const view = renderPanel()
    await act(async () => {})
    expect(topologyFetches).toBe(1)

    const nameInput = view.container.querySelector('.config-body .field input') as HTMLInputElement
    expect(nameInput).not.toBeNull()
    fireEvent.input(nameInput, { target: { value: '编辑中的名称' } })

    // 模拟 App 轮询: 全新 props 对象(onClose/onSelectGroup 新身份, onToast 稳定)触发重渲染
    view.rerender(
      <ConfigPanel
        groups={['demo', 'other']}
        currentGroup="demo"
        onClose={() => {}}
        onSelectGroup={() => {}}
        onToast={toast}
      />,
    )
    await act(async () => {})

    // effect 未重跑 → 未重新加载; 输入值保持
    expect(topologyFetches).toBe(1)
    const after = view.container.querySelector('.config-body .field input') as HTMLInputElement
    expect(after.value).toBe('编辑中的名称')
  })

  it('有未保存修改时关闭需要确认', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const view = renderPanel()
    await act(async () => {})

    const nameInput = view.container.querySelector('.config-body .field input') as HTMLInputElement
    fireEvent.input(nameInput, { target: { value: '未保存的编辑' } })

    fireEvent.click(view.getByRole('button', { name: '关闭' }))
    expect(confirmSpy).toHaveBeenCalledWith('有未保存的修改，关闭将丢弃。确认关闭？')
    expect(onClose).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    fireEvent.click(view.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('有未保存修改时切换项目群需要确认', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const view = renderPanel()
    await act(async () => {})

    const nameInput = view.container.querySelector('.config-body .field input') as HTMLInputElement
    fireEvent.input(nameInput, { target: { value: '未保存的编辑' } })

    const select = view.container.querySelector('.config-toolbar select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'other' } })
    expect(topologyFetches).toBe(1) // 确认被拒 → 未加载新群
    expect(onSelectGroup).not.toHaveBeenCalled()
  })
})

// simulate-service-dependencies：服务级边录入 + 单行渲染 + 体检告警条。
describe('ConfigPanel 依赖录入与图体检', () => {
  async function renderTwoServices(): Promise<ReturnType<typeof render>> {
    topologyFixture = twoServices
    const view = renderPanel(['demo'])
    await act(async () => {})
    return view
  }

  function depLabels(view: ReturnType<typeof render>): string[] {
    return [...view.container.querySelectorAll('.dep-label')].map((el) => el.textContent ?? '')
  }

  async function addDependency(view: ReturnType<typeof render>): Promise<void> {
    fireEvent.click(view.getByRole('button', { name: '➕ 添加依赖' }))
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: '💾 添加' }))
    await act(async () => {})
  }

  it('只选两个下拉即可录入服务级边，渲染为 A ──▶ B（无方法名/尾随空白）', async () => {
    const view = await renderTwoServices()
    fireEvent.click(view.getByRole('button', { name: '➕ 添加依赖' }))
    await act(async () => {})
    // 端点明细收在可折叠区块里，不填也能保存
    expect(view.container.querySelector('details summary')?.textContent).toBe('端点明细（可选）')

    fireEvent.click(view.getByRole('button', { name: '💾 添加' }))
    await act(async () => {})

    expect(depLabels(view)).toEqual(['user-service ──▶ order-service'])
    expect(depLabels(view)[0]).not.toContain('GET')
    expect(depLabels(view)[0]).not.toMatch(/\s$/)
  })

  it('重复添加同一对服务仍只有一行', async () => {
    const view = await renderTwoServices()
    await addDependency(view)
    await addDependency(view)
    expect(depLabels(view)).toHaveLength(1)
  })

  it('填了端点明细时保留原有 A ──method path──▶ B 形态', async () => {
    const view = await renderTwoServices()
    fireEvent.click(view.getByRole('button', { name: '➕ 添加依赖' }))
    await act(async () => {})
    const pathInput = view.container.querySelector('details input') as HTMLInputElement
    fireEvent.input(pathInput, { target: { value: '/api/orders' } })
    fireEvent.click(view.getByRole('button', { name: '💾 添加' }))
    await act(async () => {})

    expect(depLabels(view)).toEqual(['user-service ──GET /api/orders──▶ order-service'])
  })

  it('保存后拉取体检，有问题时显示告警条（环/悬空/孤立）', async () => {
    healthFixture = {
      cyclic: true,
      cycles: [['user-service', 'order-service']],
      dangling: [{ from: 'user-service', to: 'ghost' }],
      isolated: ['lonely-service'],
    }
    const view = await renderTwoServices()
    fireEvent.click(view.getByRole('button', { name: '💾 保存' }))
    await act(async () => {})

    const strip = view.getByRole('status')
    expect(strip.textContent).toContain('user-service → order-service')
    expect(strip.textContent).toContain('user-service → ghost')
    expect(strip.textContent).toContain('lonely-service')
    expect(strip.textContent).toContain('不影响保存')
  })

  it('图干净时不显示告警条', async () => {
    const view = await renderTwoServices()
    fireEvent.click(view.getByRole('button', { name: '💾 保存' }))
    await act(async () => {})

    expect(view.container.querySelector('.health-strip')).toBeNull()
    expect(view.queryByRole('status')).toBeNull()
  })
})
