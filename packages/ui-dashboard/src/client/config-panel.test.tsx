// @vitest-environment jsdom
// ConfigPanel 回归测试：锁定「父组件轮询重渲染不得覆盖未保存编辑」与
// 「dirty 时关闭/切群需确认」两个行为。
// 背景: 曾因 useEffect 依赖含整个 props 对象, App 每 5s/1.5s 轮询 dispatch loaded
// 触发 effect 重跑, loadTopology 用服务端值覆盖编辑中的 topology。
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigPanel } from './App'
import type { TopologyPayload } from './api'

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

let topologyFetches = 0

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
  toast.mockClear()
  onClose.mockClear()
  onSelectGroup.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/topology?')) {
      topologyFetches++
      return jsonResponse({ group: 'demo', topology })
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
