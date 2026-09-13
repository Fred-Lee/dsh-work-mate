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
import type {
  DeclarationDriftPayload,
  DeriveCandidatePayload,
  DeriveOutcomePayload,
  DriftEntryPayload,
  GraphHealthPayload,
  TopologyPayload,
} from './api'

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
let ignoreBodies: Array<{ group: string; keys: string[] }> = []
let restoreBodies: Array<{ group: string; keys?: string[] }> = []
let deriveIgnored: Array<{ key: string; at: number; note?: string }> = []

describe('ConfigPanel 推导候选区块', () => {
  beforeEach(() => {
    deriveFixture = deriveOutcome
    deriveAvailable = true
    applyBodies = []
    ignoreBodies = []
    restoreBodies = []
    deriveIgnored = []
    topologyFixture = twoServices
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/topology?')) return jsonResponse({ group: 'demo', topology: topologyFixture })
      if (url.includes('/api/topology/health')) return jsonResponse({ group: 'demo', health: cleanHealth, available: true })
      if (url.includes('/api/topology/derive/ignore')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { group: string; keys: string[] }
        ignoreBodies.push(body)
        return jsonResponse({ group: 'demo', ignored: body.keys.map((k) => ({ key: k, at: 1 })), available: true })
      }
      if (url.includes('/api/topology/derive/restore')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { group: string; keys?: string[] }
        restoreBodies.push(body)
        return jsonResponse({ group: 'demo', ignored: (body.keys ?? []).map((k) => ({ key: k, at: 1 })), available: true })
      }
      if (url.includes('/api/topology/derive')) {
        return jsonResponse({ group: 'demo', result: deriveFixture, available: deriveAvailable, ignored: deriveIgnored })
      }
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
    fireEvent.click(view.getByRole('button', { name: '🔍 推导候选（快扫）' }))
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

  it('「忽略」落库为持久化忽略清单，行即时移出，并出现「已忽略」区', async () => {
    const view = await renderWithCandidates()
    const declared = view.container.querySelector('[data-candidate="user-service → order-service"]') as HTMLElement
    fireEvent.click(within(declared).getByRole('button', { name: '🙈 忽略' }))
    await act(async () => {})

    // 落库：POST /derive/ignore，键为 from→to（服务对）
    expect(ignoreBodies).toEqual([{ group: 'demo', keys: ['user-service→order-service'] }])
    expect(applyBodies).toHaveLength(0)
    expect(rows(view)).toHaveLength(2)
    expect(view.container.querySelector('[data-candidate="user-service → order-service"]')).toBeNull()
  })

  it('「已忽略」区可逐条恢复与全部恢复，恢复后重跑推导', async () => {
    deriveIgnored = [{ key: 'user-service→oss', at: 1 }]
    const view = await renderWithCandidates()
    expect(view.container.textContent).toContain('已忽略（1）')

    fireEvent.click(view.getByRole('button', { name: '♻️ 恢复' }))
    await act(async () => {})
    expect(restoreBodies).toEqual([{ group: 'demo', keys: ['user-service→oss'] }])

    fireEvent.click(view.getByRole('button', { name: '♻️ 全部恢复' }))
    await act(async () => {})
    expect(restoreBodies[1]).toEqual({ group: 'demo' })
  })

  it('无持久化忽略时不显示「已忽略」区', async () => {
    const view = await renderWithCandidates()
    expect(view.container.textContent).not.toContain('已忽略（')
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

// ---------------------------------------------------------------------------
// declare-dependencies-in-repo：📥 从仓库抓取依赖（复用导入预览对话框）与
// 💾 写回声明文件（只含 declared 边 + 目标路径 + 提示）。
// ---------------------------------------------------------------------------

/** 抓取结果：声明 user-service → order-service（已登记）+ internal-qp（未登记）。 */
const declarationPreview = {
  source: 'helmsman-declaration',
  services: [
    { name: 'user-service', selected: true, endpoints: [] },
    { name: 'internal-qp', selected: true, endpoints: [] },
  ],
  dependencies: [
    { from: 'user-service', to: 'order-service', method: '*', endpoints: [] },
    { from: 'user-service', to: 'internal-qp', method: 'GET', endpoints: ['/qp/list'] },
  ],
  warnings: [],
  declaration: { service: 'user-service', file: '/tmp/user-service/.helmsman/dependencies.yml' },
  undeclaredTargets: ['internal-qp'],
}

const declaredTopology: TopologyPayload = {
  ...twoServices,
  restDependencies: {
    'user-service': [
      { toServiceId: 'order-service', endpoints: [], method: '*' },
      { toServiceId: 'internal-qp', endpoints: ['/qp/list'], method: 'GET' },
    ],
  },
}

let declarationFixture: Record<string, unknown> = {
  group: 'demo',
  service: 'user-service',
  file: '/tmp/user-service/.helmsman/dependencies.yml',
  status: 'ok',
  preview: declarationPreview,
  errors: [],
  warnings: [],
  undeclaredTargets: ['internal-qp'],
  available: true,
}
let importApplyBodies: Array<{ group: string; preview: Record<string, unknown> }> = []

describe('ConfigPanel 仓库依赖声明（抓取 + 写回）', () => {
  beforeEach(() => {
    topologyFixture = twoServices
    declarationFixture = {
      group: 'demo',
      service: 'user-service',
      file: '/tmp/user-service/.helmsman/dependencies.yml',
      status: 'ok',
      preview: declarationPreview,
      errors: [],
      warnings: [],
      undeclaredTargets: ['internal-qp'],
      available: true,
    }
    importApplyBodies = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/topology?')) return jsonResponse({ group: 'demo', topology: topologyFixture })
      if (url.includes('/api/topology/health')) return jsonResponse({ group: 'demo', health: cleanHealth, available: true })
      if (url.includes('/api/topology/declaration/render')) {
        return jsonResponse({
          group: 'demo',
          service: 'user-service',
          file: '/tmp/user-service/.helmsman/dependencies.yml',
          content: 'version: 1\nservice: user-service\ndependencies:\n  - to: order-service\n',
          declared: 1,
          derived: 1,
          hint: '建议把内容写入 .helmsman/dependencies.yml 并随代码提交（Helmsman 不执行任何 git 操作）。',
          available: true,
        })
      }
      if (url.includes('/api/topology/declaration')) return jsonResponse(declarationFixture)
      if (url.includes('/api/topology/import-apply')) {
        importApplyBodies.push(JSON.parse(String(init?.body ?? '{}')) as { group: string; preview: Record<string, unknown> })
        return jsonResponse({ topology: declaredTopology })
      }
      return jsonResponse({ ok: true })
    }))
  })

  async function openDeclarationFetch(): Promise<ReturnType<typeof render>> {
    const view = renderPanel(['demo'])
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: '📥 从仓库抓取依赖' }))
    await act(async () => {})
    return view
  }

  it('抓取入口复用预览对话框核对，未登记目标可勾选登记，应用走 importApply', async () => {
    const view = await openDeclarationFetch()
    // 与「导入」共用同一个预览对话框，但默认在声明源上
    const dialog = view.getByRole('dialog', { name: '导入架构' })
    expect(within(dialog).getByText(/仓库内声明/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '📥 抓取仓库声明' }))
    await act(async () => {})

    // 预览：本服务 + 未登记目标（标记 + 可勾选登记）
    expect(dialog.textContent).toContain('user-service')
    expect(dialog.textContent).toContain('目标未登记（勾选即登记）')
    expect(dialog.textContent).toContain('user-service→order-service, user-service→internal-qp')
    expect(dialog.textContent).toContain('声明服务 user-service')
    expect(dialog.textContent).toContain('/tmp/user-service/.helmsman/dependencies.yml')

    fireEvent.click(within(dialog).getByRole('button', { name: '✅ 应用声明' }))
    await act(async () => {})

    expect(importApplyBodies).toHaveLength(1)
    expect(importApplyBodies[0]!.group).toBe('demo')
    expect(importApplyBodies[0]!.preview).toMatchObject({ source: 'helmsman-declaration', declaration: { service: 'user-service' } })
    expect(toast).toHaveBeenCalledWith('success', expect.stringContaining('已按仓库声明对齐依赖'))
    // 依赖行由服务端返回的拓扑驱动（一对服务一行）
    expect([...view.container.querySelectorAll('.dep-line .dep-label')].map((el) => el.textContent)).toEqual([
      'user-service ──▶ order-service',
      'user-service ──GET /qp/list──▶ internal-qp',
    ])
  })

  it('仓库没有声明文件时给出「未声明依赖」的友好提示（非错误、不产出依赖）', async () => {
    declarationFixture = { group: 'demo', service: 'user-service', file: '/tmp/user-service/.helmsman/dependencies.yml', status: 'missing', preview: null, errors: [], warnings: [], undeclaredTargets: [], available: true }
    const view = await openDeclarationFetch()
    const dialog = view.getByRole('dialog', { name: '导入架构' })
    fireEvent.click(within(dialog).getByRole('button', { name: '📥 抓取仓库声明' }))
    await act(async () => {})

    expect(dialog.textContent).toContain('该项目未声明依赖')
    expect((within(dialog).getByRole('button', { name: '✅ 应用声明' }) as HTMLButtonElement).disabled).toBe(true)
    expect(toast).not.toHaveBeenCalledWith('error', expect.anything())
  })

  it('声明文件解析失败时列出问题且无法应用（不做部分应用）', async () => {
    declarationFixture = {
      group: 'demo',
      service: 'user-service',
      file: '/tmp/user-service/.helmsman/dependencies.yml',
      status: 'invalid',
      preview: null,
      errors: ['dependencies[1] 缺少必填字段 to（被调用的服务 id）'],
      warnings: [],
      undeclaredTargets: [],
      available: true,
    }
    const view = await openDeclarationFetch()
    const dialog = view.getByRole('dialog', { name: '导入架构' })
    fireEvent.click(within(dialog).getByRole('button', { name: '📥 抓取仓库声明' }))
    await act(async () => {})

    expect(dialog.textContent).toContain('声明文件解析失败，未应用任何依赖')
    expect(dialog.textContent).toContain('缺少必填字段 to')
    expect((within(dialog).getByRole('button', { name: '✅ 应用声明' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('旧版本拓扑服务不支持抓取时给出提示而不是报错', async () => {
    declarationFixture = { group: 'demo', service: 'user-service', file: null, status: 'unavailable', preview: null, errors: [], warnings: [], undeclaredTargets: [], available: false }
    const view = await openDeclarationFetch()
    const dialog = view.getByRole('dialog', { name: '导入架构' })
    fireEvent.click(within(dialog).getByRole('button', { name: '📥 抓取仓库声明' }))
    await act(async () => {})
    expect(dialog.textContent).toContain('当前拓扑服务版本不支持仓库声明抓取')
  })

  it('写回入口展示内容与目标路径、提示提交仓库，且不含推导边', async () => {
    const view = renderPanel(['demo'])
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: '💾 写回声明文件' }))
    await act(async () => {})

    const dialog = view.getByRole('dialog', { name: '写回声明文件' })
    expect(dialog.textContent).toContain('/tmp/user-service/.helmsman/dependencies.yml')
    expect(dialog.textContent).toContain('建议把内容写入')
    expect(dialog.textContent).toContain('不执行任何 git 操作')
    // 只写 declared 边；另有 derived 边时明确说明不会写入
    expect(dialog.textContent).toContain('本次写入 1 条')
    expect(dialog.textContent).toContain('另有 1 条 derived 边')
    const content = (dialog.querySelector('textarea[aria-label="声明文件内容"]') as HTMLTextAreaElement).value
    expect(content).toContain('- to: order-service')
    expect(content).not.toContain('derived')
  })
})

// ---------------------------------------------------------------------------
// detect-declaration-drift：🔎 漂移核对结果区（三组 + 中置信分列 + 保留措辞 +
// 只读引导；无声明文件时是引导态；与图体检并列而不合并）
// ---------------------------------------------------------------------------

/** 一致的条目：声明了且代码有证据。 */
const driftConsistent: DriftEntryPayload = {
  from: 'user-service',
  to: 'order-service',
  evidence: [{ kind: 'config', file: 'src/main/resources/application.yml', line: 8, detail: 'order-service.base-url = http://order-service:8080' }],
  endpoints: [],
  confidence: 'high',
  targetDeclared: true,
  declared: { method: '*', endpoints: [] },
}

/** 陈旧声明：仅声明有，代码里没找到证据（不得表述为「不存在」）。 */
const driftStale: DriftEntryPayload = {
  from: 'user-service',
  to: 'internal-legacy',
  evidence: [],
  endpoints: [],
  targetDeclared: true,
  declared: { method: '*', endpoints: [] },
  reason: '未在代码中找到证据（可能确实已删除，也可能是动态构造的调用未被识别）',
  caveat: '扫描为静态且启发式：动态拼接的 URL、配置驱动的路径都可能未被识别，因此这一条表示「需要人工确认」。',
  action: '请人工确认该调用是否还在，再决定是否从声明文件里删除；Helmsman 不会代为修改声明文件。',
}

/** 未声明：高置信（名称档）代码证据但声明没提，目标还没登记。 */
const driftUndeclared: DriftEntryPayload = {
  from: 'user-service',
  to: 'internal-bc-es',
  evidence: [{ kind: 'feign', file: 'src/main/java/com/example/InternalBcEsClient.java', line: 3, detail: '@FeignClient(name = "internal-bc-es")' }],
  endpoints: [],
  confidence: 'high',
  targetDeclared: false,
  declared: null,
}

/** 中置信（路径档）单列：不计入未声明判定。 */
const driftMedium: DriftEntryPayload = {
  from: 'user-service',
  to: 'internal-qp',
  evidence: [{ kind: 'endpoint', file: 'src/client/qp.ts', line: 5, detail: '/qp/list ↔ GET /api/qp/list（internal-qp 已声明该端点）', note: '按路径后缀匹配' }],
  endpoints: ['/api/qp/list'],
  method: 'GET',
  confidence: 'medium',
  targetDeclared: true,
  declared: null,
  tierNote: '中置信（路径档）：调用路径经模板归一化后可能命中多个服务，故只作参考、不计入漂移判定。',
}

const driftFixture: DeclarationDriftPayload = {
  group: 'demo',
  service: 'user-service',
  status: 'ok',
  file: '/tmp/user-service/.helmsman/dependencies.yml',
  consistent: [driftConsistent],
  staleDeclared: [driftStale],
  undeclared: [driftUndeclared],
  mediumConfidence: [driftMedium],
  counts: { declared: 2, codeEvidence: 3, consistent: 1, staleDeclared: 1, undeclared: 1, mediumConfidence: 1, drift: 2 },
  hasDrift: true,
  message: '核对完成：声明 2 对 / 代码证据 3 对 —— 一致 1 对，需人工确认的陈旧声明 1 对（未在代码中找到证据），未声明 1 对。',
  errors: [],
  scanned: ['user-service'],
  skipped: [],
  scannedAt: 1_700_000_000_000,
  available: true,
}

let driftReply: DeclarationDriftPayload | { error: string } = driftFixture
let driftCalls: string[] = []
let writeCalls: string[] = []
let deriveCalls = 0

describe('ConfigPanel 漂移核对', () => {
  beforeEach(() => {
    driftReply = driftFixture
    driftCalls = []
    writeCalls = []
    deriveCalls = 0
    topologyFixture = twoServices
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/topology?')) return jsonResponse({ group: 'demo', topology: topologyFixture })
      if (url.includes('/api/topology/health')) return jsonResponse({ group: 'demo', health: cleanHealth, available: true })
      if (url.includes('/api/topology/drift')) {
        driftCalls.push(url)
        if ('error' in driftReply) {
          return { ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => driftReply } as unknown as Response
        }
        return jsonResponse(driftReply)
      }
      if (url.includes('/api/topology/derive')) {
        deriveCalls++
        return jsonResponse({ group: 'demo', result: deriveOutcome, available: true })
      }
      if (url.includes('/api/topology/declaration/render')) {
        return jsonResponse({
          group: 'demo',
          service: 'user-service',
          file: '/tmp/user-service/.helmsman/dependencies.yml',
          content: 'version: 1\nservice: user-service\ndependencies:\n  - to: order-service\n',
          declared: 1,
          derived: 0,
          hint: '建议把内容写入 .helmsman/dependencies.yml 并随代码提交（Helmsman 不执行任何 git 操作）。',
          available: true,
        })
      }
      // 任何写入路径都被记录下来：漂移核对绝不允许走这些入口。
      if (init?.method === 'POST' || url.includes('/save') || url.includes('apply-candidates') || url.includes('import-apply')) {
        writeCalls.push(`${init?.method ?? 'GET'} ${url}`)
      }
      return jsonResponse({ ok: true })
    }))
  })

  async function runDriftCheck(): Promise<ReturnType<typeof render>> {
    const view = renderPanel(['demo'])
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: '🔎 漂移核对' }))
    await act(async () => {})
    return view
  }

  it('渲染三组 + 中置信分列，带服务对、证据、计数与陈旧声明的保留措辞', async () => {
    const view = await runDriftCheck()
    expect(driftCalls).toHaveLength(1)
    expect(driftCalls[0]).toContain('group=demo')
    expect(driftCalls[0]).toContain('service=user-service')

    const block = view.container.querySelector('.drift-block') as HTMLElement
    expect(block).not.toBeNull()
    // 三组标题（一致 / 陈旧声明 / 未声明）+ 中置信单列
    expect(block.textContent).toContain('一致（1）')
    expect(block.textContent).toContain('陈旧声明 · 需要人工确认（1）')
    expect(block.textContent).toContain('未声明（1）')
    expect(block.textContent).toContain('可能未声明（中置信）（1）')
    // 每条显示服务对与证据
    expect(block.textContent).toContain('user-service ──▶ order-service')
    expect(block.textContent).toContain('order-service.base-url = http://order-service:8080')
    expect(block.textContent).toContain('@FeignClient(name = "internal-bc-es")')
    expect(block.textContent).toContain('/qp/list ↔ GET /api/qp/list')
    // 陈旧声明的保留措辞：只说「未在代码中找到证据」+ 静态扫描的局限
    expect(block.textContent).toContain('未在代码中找到证据')
    expect(block.textContent).toContain('扫描为静态且启发式')
    expect(block.textContent).toContain('需要人工确认')
    expect(block.textContent).not.toContain('不存在')
    expect(block.textContent).not.toContain('已失效')
    // 不提供「一键删除陈旧声明」
    expect(block.textContent).not.toContain('删除陈旧声明')
    // 未声明条目的目标未登记标记 + 计数
    expect(block.textContent).toContain('目标未登记')
    const counts = block.querySelector('[data-drift-counts]') as HTMLElement
    expect(counts.textContent).toContain('声明 2 对')
    expect(counts.textContent).toContain('一致 1')
    expect(counts.textContent).toContain('未声明 1')
    // 中置信不计入未声明：中置信条目不在「未声明」组里
    const groups = [...block.querySelectorAll('.candidate-group')]
    const undeclaredGroup = groups.find((g) => g.textContent?.includes('未声明（1）'))!
    expect(undeclaredGroup.textContent).toContain('internal-bc-es')
    expect(undeclaredGroup.textContent).not.toContain('internal-qp')
    const mediumGroup = groups.find((g) => g.textContent?.includes('可能未声明（中置信）'))!
    expect(mediumGroup.textContent).toContain('internal-qp')
    expect(mediumGroup.textContent).toContain('不计入漂移判定')
    // 与图体检并列、不合并：告警条是独立的一块（图干净时它不渲染）
    expect(view.container.querySelector('.health-strip')).toBeNull()
  })

  it('「去处理」只跳进既有候选确认流程（推导候选），不在此处写入任何东西', async () => {
    const view = await runDriftCheck()
    const undeclaredEntry = view.container.querySelector('[data-drift="internal-bc-es"]') as HTMLElement
    fireEvent.click(within(undeclaredEntry).getByRole('button', { name: '➡️ 去候选确认' }))
    await act(async () => {})

    // 走到既有推导候选流程（GET 只读），候选行出现并可继续用「确认/登记并确认」处理
    expect(deriveCalls).toBe(1)
    expect(view.container.querySelector('[data-candidate="user-service → internal-bc-es"]')).not.toBeNull()
    // 核对界面本身没有任何写入动作
    expect(writeCalls).toEqual([])
  })

  it('声明与代码一致时不显示漂移结果区（无漂移不显示告警）', async () => {
    driftReply = {
      ...driftFixture,
      status: 'ok',
      staleDeclared: [],
      undeclared: [],
      mediumConfidence: [],
      counts: { declared: 1, codeEvidence: 1, consistent: 1, staleDeclared: 0, undeclared: 0, mediumConfidence: 0, drift: 0 },
      hasDrift: false,
      message: '核对完成：声明与代码证据一致（一致 1 对，声明 1 对 / 代码证据 1 对）。',
    }
    const view = await runDriftCheck()
    expect(view.container.querySelector('.drift-block')).toBeNull()
    expect(toast).toHaveBeenCalledWith('success', expect.stringContaining('未发现漂移'))
  })

  it('无声明文件时是引导态：说明尚未声明、列出全部代码证据、引导写回基线', async () => {
    driftReply = {
      ...driftFixture,
      status: 'no-declaration',
      file: '/tmp/user-service/.helmsman/dependencies.yml',
      consistent: [],
      staleDeclared: [],
      counts: { declared: 0, codeEvidence: 2, consistent: 0, staleDeclared: 0, undeclared: 1, mediumConfidence: 1, drift: 1 },
      hasDrift: false,
      message: '服务 user-service 尚未声明依赖（未找到 .helmsman/dependencies.yml）：以下 2 条代码证据均未经声明（高置信 1 条、中置信 1 条单列）。',
    }
    const view = await runDriftCheck()

    const block = view.container.querySelector('.drift-block') as HTMLElement
    expect(block.textContent).toContain('尚未声明依赖')
    expect(block.textContent).toContain('均未经声明')
    expect(block.textContent).toContain('未声明（1）')
    expect(block.textContent).toContain('可能未声明（中置信）（1）')
    // 引导写回一份基线（复用既有写回对话框，不执行任何 git 操作）
    fireEvent.click(within(block).getByRole('button', { name: '💾 写回声明文件（建立基线）' }))
    await act(async () => {})
    expect(view.getByRole('dialog', { name: '写回声明文件' })).toBeTruthy()
    expect(writeCalls).toEqual([])
  })

  it('声明文件解析失败时列出问题、不产出判定（明确报错而非静默）', async () => {
    driftReply = {
      ...driftFixture,
      status: 'invalid-declaration',
      consistent: [],
      staleDeclared: [],
      undeclared: [],
      mediumConfidence: [],
      counts: { declared: 0, codeEvidence: 0, consistent: 0, staleDeclared: 0, undeclared: 0, mediumConfidence: 0, drift: 0 },
      hasDrift: false,
      message: '声明文件无法解析，未做任何比对、未产出部分结论；请先修正声明文件再核对。',
      errors: ['缺少必填字段 service（本服务在项目群中的 id，是每条依赖边的调用方）'],
    }
    const view = await runDriftCheck()
    const block = view.container.querySelector('.drift-block') as HTMLElement
    expect(block.textContent).toContain('未做任何比对')
    expect(block.textContent).toContain('缺少必填字段 service')
    // 没有判定可展示：三组都不渲染
    expect(block.textContent).not.toContain('未声明（')
    expect(view.container.querySelectorAll('.candidate-group')).toHaveLength(0)
  })

  it('老版本拓扑服务（available:false）给出升级提示而不是报错', async () => {
    driftReply = { ...driftFixture, status: 'unavailable', consistent: [], staleDeclared: [], undeclared: [], mediumConfidence: [], hasDrift: false, available: false, message: '' }
    const view = await runDriftCheck()
    expect(view.container.textContent).toContain('当前拓扑服务版本不支持漂移核对')
    expect(view.container.querySelector('.drift-block')).toBeNull()
    expect(toast).not.toHaveBeenCalledWith('error', expect.anything())
  })

  it('核对失败时走错误提示，不显示半截结果', async () => {
    driftReply = { error: 'service not found in group: ghost' }
    const view = await runDriftCheck()
    expect(toast).toHaveBeenCalledWith('error', expect.stringContaining('service not found in group: ghost'))
    expect(view.container.querySelector('.drift-block')).toBeNull()
  })

  it('核对的服务可在依赖拓扑里选择（默认挑有工作副本的服务）', async () => {
    const view = await runDriftCheck()
    const select = view.container.querySelector('select[aria-label="漂移核对的服务"]') as HTMLSelectElement
    expect(select.value).toBe('user-service')
    fireEvent.change(select, { target: { value: 'order-service' } })
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: '🔎 漂移核对' }))
    await act(async () => {})
    expect(driftCalls).toHaveLength(2)
    expect(driftCalls[1]).toContain('service=order-service')
  })
})
