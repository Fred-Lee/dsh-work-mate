// @vitest-environment jsdom
// ConfigPanel 回归测试：锁定「父组件轮询重渲染不得覆盖未保存编辑」与
// 「dirty 时关闭/切群需确认」两个行为。
// 背景: 曾因 useEffect 依赖含整个 props 对象, App 每 5s/1.5s 轮询 dispatch loaded
// 触发 effect 重跑, loadTopology 用服务端值覆盖编辑中的 topology。
// 另含 simplify-service-dependencies 的行为锁定：只选两个下拉即可录入服务级边、
// 同一对服务只占一行、无明细行渲染降级、保存后的图体检告警条。
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigPanel } from './App'
import type { DeriveCandidatePayload, DeriveOutcomePayload, GraphHealthPayload, TopologyPayload } from './api'

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

// ---------------------------------------------------------------------------
// derive-dependencies-from-calls：推导候选区块（证据/置信度/未登记目标/成环项）
// ---------------------------------------------------------------------------

const deriveCandidates: DeriveCandidatePayload[] = [
  {
    from: 'user-service',
    to: 'order-service',
    confidence: 'high',
    evidence: [{ kind: 'config', file: 'src/main/resources/application.yml', line: 8, detail: 'order-service.base-url = http://order-service:8080' }],
    endpoints: [],
    targetDeclared: true,
    alreadyDeclared: false,
    wouldCreateCycle: false,
  },
  {
    from: 'user-service',
    to: 'internal-bc-es',
    confidence: 'high',
    evidence: [
      {
        kind: 'feign',
        file: 'src/main/java/com/example/InternalBcEsClient.java',
        line: 3,
        detail: '@FeignClient(name = "${project.feign-client-config.internal-bc-es.name}")',
        note: '值未解析（本地配置中未找到 project.feign-client-config.internal-bc-es.name）',
      },
    ],
    endpoints: [],
    targetDeclared: false,
    wouldCreateCycle: false,
  },
  {
    from: 'order-service',
    to: 'user-service',
    confidence: 'medium',
    evidence: [
      {
        kind: 'endpoint',
        file: 'src/client/orders.ts',
        line: 12,
        detail: '/api/users/{id} ↔ GET /api/users/{uid}（user-service 已声明该端点）',
        note: '按段形状归一化匹配',
      },
    ],
    endpoints: ['/api/users/{uid}'],
    method: 'GET',
    targetDeclared: true,
    wouldCreateCycle: true,
  },
]

const deriveOutcome: DeriveOutcomePayload = {
  candidates: deriveCandidates,
  scannedAt: 1_700_000_000_000,
  scanned: ['user-service', 'order-service'],
  skipped: [{ serviceId: 'lonely-service', reason: '未配置本地路径（localPath）' }],
}

/** 确认后服务端返回的拓扑：依赖行即时更新（含被确认的一行）。 */
const appliedTopology: TopologyPayload = {
  ...twoServices,
  restDependencies: { 'user-service': [{ toServiceId: 'order-service', endpoints: [], method: '*' }] },
}

let deriveFixture: DeriveOutcomePayload | null = deriveOutcome
let deriveAvailable = true
let applyBodies: Array<{ group: string; candidates: unknown[] }> = []

describe('ConfigPanel 推导候选区块', () => {
  beforeEach(() => {
    deriveFixture = deriveOutcome
    deriveAvailable = true
    applyBodies = []
    topologyFixture = twoServices
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/topology?')) return jsonResponse({ group: 'demo', topology: topologyFixture })
      if (url.includes('/api/topology/health')) return jsonResponse({ group: 'demo', health: cleanHealth, available: true })
      if (url.includes('/api/topology/derive')) return jsonResponse({ group: 'demo', result: deriveFixture, available: deriveAvailable })
      if (url.includes('/api/topology/apply-candidates')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { group: string; candidates: unknown[] }
        applyBodies.push(body)
        return jsonResponse({ group: 'demo', applied: body.candidates.length, registered: [], topology: appliedTopology, available: true })
      }
      return jsonResponse({ ok: true })
    }))
  })

  async function renderWithCandidates(): Promise<ReturnType<typeof render>> {
    const view = renderPanel(['demo'])
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: '🔍 推导候选' }))
    await act(async () => {})
    return view
  }

  function rows(view: ReturnType<typeof render>): HTMLElement[] {
    return [...view.container.querySelectorAll<HTMLElement>('.candidate-row')]
  }

  it('逐条展示证据、置信度徽标与匹配端点，成环项默认不勾选', async () => {
    const view = await renderWithCandidates()
    expect(rows(view)).toHaveLength(3)

    const declared = view.container.querySelector('[data-candidate="user-service → order-service"]') as HTMLElement
    expect(declared.textContent).toContain('user-service ──▶ order-service')
    expect(declared.textContent).toContain('http://order-service:8080')
    expect(declared.textContent).toContain('application.yml:8')
    expect(declared.querySelector('[aria-label="置信度 高"]')).not.toBeNull()

    // 未登记目标：单列一组 + 标记 + 「登记并确认」
    const undeclared = view.container.querySelector('[data-candidate="user-service → internal-bc-es"]') as HTMLElement
    expect(undeclared.textContent).toContain('目标未登记')
    expect(undeclared.textContent).toContain('值未解析')
    expect(within(undeclared).getByRole('button', { name: '📝 登记并确认' })).toBeTruthy()
    expect(view.container.textContent).toContain('目标未登记（可登记并确认）（1）')

    // 成环项：标记 + 默认不勾选；非成环项默认勾选
    const cycle = view.container.querySelector('[data-candidate="order-service → user-service"]') as HTMLElement
    expect(cycle.textContent).toContain('将形成环')
    expect(cycle.textContent).toContain('端点明细：GET /api/users/{uid}')
    expect(cycle.textContent).toContain('按段形状归一化匹配')
    expect(checkboxOf(cycle).checked).toBe(false)
    expect(checkboxOf(declared).checked).toBe(true)
    expect(checkboxOf(undeclared).checked).toBe(true)
    expect(view.container.textContent).toContain('未扫描：lonely-service（未配置本地路径（localPath））')
  })

  it('「全部确认(不含成环项)」只送勾选的非成环候选，确认后依赖行即时更新且只有一行', async () => {
    const view = await renderWithCandidates()
    // 手工勾上成环项也不随批量写入（必须逐条确认）。
    const cycle = view.container.querySelector('[data-candidate="order-service → user-service"]') as HTMLElement
    fireEvent.click(checkboxOf(cycle))
    await act(async () => {})

    fireEvent.click(view.getByRole('button', { name: '✅ 全部确认（不含成环项）' }))
    await act(async () => {})

    expect(applyBodies).toHaveLength(1)
    expect(applyBodies[0]!.group).toBe('demo')
    expect(applyBodies[0]!.candidates).toEqual([
      { from: 'user-service', to: 'order-service' },
      { from: 'user-service', to: 'internal-bc-es', register: true },
    ])

    // 依赖行由服务端返回的拓扑驱动：一对服务一行，已确认的候选从清单移除。
    const depLabels = [...view.container.querySelectorAll('.dep-line .dep-label')].map((el) => el.textContent)
    expect(depLabels).toEqual(['user-service ──▶ order-service'])
    expect(rows(view)).toHaveLength(1)
    expect(view.container.querySelector('[data-candidate="user-service → order-service"]')).toBeNull()
    expect(toast).toHaveBeenCalledWith('success', expect.stringContaining('已确认 2 条候选'))
  })

  it('单条「登记并确认」带 register，单条「确认」按端点明细落库', async () => {
    const view = await renderWithCandidates()

    const undeclared = view.container.querySelector('[data-candidate="user-service → internal-bc-es"]') as HTMLElement
    fireEvent.click(within(undeclared).getByRole('button', { name: '📝 登记并确认' }))
    await act(async () => {})
    expect(applyBodies[0]!.candidates).toEqual([{ from: 'user-service', to: 'internal-bc-es', register: true }])

    // 手动勾选成环项后才能单条确认；带上匹配到的端点与 HTTP 方法。
    const cycle = view.container.querySelector('[data-candidate="order-service → user-service"]') as HTMLElement
    fireEvent.click(checkboxOf(cycle))
    await act(async () => {})
    fireEvent.click(within(cycle).getByRole('button', { name: '✅ 确认' }))
    await act(async () => {})
    expect(applyBodies[1]!.candidates).toEqual([
      { from: 'order-service', to: 'user-service', endpoints: ['/api/users/{uid}'], method: 'GET' },
    ])
  })

  it('未登记目标只确认依赖时需要显式确认（会产生悬空引用）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const view = await renderWithCandidates()
    const undeclared = view.container.querySelector('[data-candidate="user-service → internal-bc-es"]') as HTMLElement

    fireEvent.click(within(undeclared).getByRole('button', { name: '仅确认依赖' }))
    await act(async () => {})
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('悬空引用'))
    expect(applyBodies).toHaveLength(0)

    confirmSpy.mockReturnValue(true)
    fireEvent.click(within(undeclared).getByRole('button', { name: '仅确认依赖' }))
    await act(async () => {})
    expect(applyBodies[0]!.candidates).toEqual([{ from: 'user-service', to: 'internal-bc-es' }])
  })

  it('「忽略」把候选移出清单且不落库', async () => {
    const view = await renderWithCandidates()
    const declared = view.container.querySelector('[data-candidate="user-service → order-service"]') as HTMLElement
    fireEvent.click(within(declared).getByRole('button', { name: '🙈 忽略' }))
    await act(async () => {})

    expect(rows(view)).toHaveLength(2)
    expect(view.container.querySelector('[data-candidate="user-service → order-service"]')).toBeNull()
    expect(applyBodies).toHaveLength(0)
    expect(view.container.textContent).toContain('另有 1 条已忽略')
  })

  it('老版本拓扑服务（available:false）给出提示而不是报错', async () => {
    deriveAvailable = false
    const view = await renderWithCandidates()
    expect(view.container.textContent).toContain('当前拓扑服务版本不支持候选推导')
    expect(rows(view)).toHaveLength(0)
  })
})

function checkboxOf(row: HTMLElement): HTMLInputElement {
  const input = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  if (!input) throw new Error('candidate row has no checkbox')
  return input
}
