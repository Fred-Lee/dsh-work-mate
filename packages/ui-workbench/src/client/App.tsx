/**
 * Helmsman Workbench UI — three mount shapes from one panel body:
 *  - WorkbenchToggle: sidebar.footer.action entry (opens the drawer)
 *  - WorkbenchDrawer: shell.overlay right-side drawer (self-contained chrome)
 *  - App: standalone full-page mount (host-served /helmsman-workbench)
 *
 * Data comes from the host half's same-origin REST under /helmsman-workbench/api.
 * The execution panel embeds the ui-dashboard view (importable module, shared
 * React) with a full-page link as an escape hatch for narrow drawers.
 */
import { useEffect, useSyncExternalStore, useState } from 'react'
import { DashboardView } from '@helmsman/ui-dashboard/client/embed'
import { workbenchOpen } from './store'
import { injectStyles } from './styles'

injectStyles()

export type PanelKind = 'research' | 'prd' | 'execution' | 'knowledge'

const PANELS: Array<{ kind: PanelKind; label: string }> = [
  { kind: 'research', label: '📚 研究' },
  { kind: 'prd', label: '📋 PRD' },
  { kind: 'execution', label: '⚡ 执行' },
  { kind: 'knowledge', label: '🕸️ 知识' },
]

const BASE = '/helmsman-workbench/api'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

interface GenerateRecord {
  taskId: string
  preset: string
  status: string
  startedAt: number
  endedAt?: number
  error?: string
  draftId?: string
}

interface GraphNode {
  id: string
  type: 'service' | 'document' | 'prd' | 'api'
  label: string
}
interface GraphEdge { from: string; to: string; label?: string }

/** Sidebar footer entry: opens the workbench drawer. */
export function WorkbenchToggle({ wide }: { wide?: boolean }): React.ReactNode {
  return (
    <button
      type="button"
      className="hls-toggle-btn"
      aria-label="打开 Helmsman 工作台"
      onClick={() => { workbenchOpen.set(true) }}
    >
      <span aria-hidden="true">🚀</span>
      {wide !== false && <span>Helmsman</span>}
    </button>
  )
}

/** shell.overlay entry: the right-side workbench drawer. */
export function WorkbenchDrawer(): React.ReactNode {
  const open = useSyncExternalStore(workbenchOpen.subscribe, workbenchOpen.get)
  if (!open) return null
  return (
    <aside className="hls-drawer" role="dialog" aria-label="Helmsman 工作台">
      <header className="hls-drawer-head">
        <h3 className="hls-drawer-title">🚀 Helmsman 工作台</h3>
        <button
          type="button"
          className="hls-close"
          aria-label="关闭工作台"
          onClick={() => { workbenchOpen.set(false) }}
        >✕</button>
      </header>
      <WorkbenchPanel />
    </aside>
  )
}

/** Standalone full-page mount (host-served /helmsman-workbench). */
export function App(): React.ReactNode {
  return <WorkbenchPanel />
}

function WorkbenchPanel() {
  const [panel, setPanel] = useState<PanelKind>('research')
  const [records, setRecords] = useState<GenerateRecord[]>([])
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const refresh = async (): Promise<void> => {
    try {
      const r = await api<{ records: GenerateRecord[] }>('/records')
      setRecords(r.records)
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(t)
  }, [])

  const runGenerate = async (preset: 'research' | 'prd'): Promise<void> => {
    if (!prompt.trim()) return
    setBusy(true)
    setToast('')
    try {
      await api('/generate', {
        method: 'POST',
        body: JSON.stringify({ preset, input: { prompt } }),
      })
      setToast(`✅ 已提交 ${preset} 生成任务`)
      setPrompt('')
      await refresh()
    } catch (err) {
      setToast(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hls-body">
      <nav className="hls-tabs">
        {PANELS.map((p) => (
          <button
            key={p.kind}
            className={`hls-tab ${panel === p.kind ? 'is-active' : ''}`}
            onClick={() => setPanel(p.kind)}
          >
            {p.label}
          </button>
        ))}
      </nav>

      {panel === 'research' && (
        <section className="hls-panel">
          <h3>🔍 Deep Research</h3>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述研究主题，如：教育行业作业批改 SaaS 的市场现状与技术方案"
            rows={3}
          />
          <div className="hls-actions">
            <button className="hls-btn" disabled={busy || !prompt.trim()} onClick={() => void runGenerate('research')}>
              {busy ? '⏳ 执行中…' : '▶ 生成研究笔记'}
            </button>
          </div>
          <RecordList records={records} preset="research" />
        </section>
      )}

      {panel === 'prd' && (
        <section className="hls-panel">
          <h3>📋 PRD 生成</h3>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述需求，或贴研究笔记 id 供生成 PRD"
            rows={3}
          />
          <div className="hls-actions">
            <button className="hls-btn" disabled={busy || !prompt.trim()} onClick={() => void runGenerate('prd')}>
              {busy ? '⏳ 执行中…' : '▶ 生成 PRD 草稿'}
            </button>
          </div>
          <RecordList records={records} preset="prd" />
        </section>
      )}

      {panel === 'execution' && (
        <section className="hls-panel">
          <h3>⚡ 执行看板</h3>
          <div className="hls-actions">
            <a className="hls-link" href="/helmsman-dashboard" target="_blank" rel="noreferrer">
              ↗ 在新页面打开完整看板
            </a>
          </div>
          {/* Embedded ui-dashboard view (importable module, same React). */}
          <DashboardView />
        </section>
      )}

      {panel === 'knowledge' && (
        <section className="hls-panel">
          <h3>🕸️ 知识图谱</h3>
          <div className="hls-actions">
            <button className="hls-btn" onClick={() => void loadGraph(setGraph, setToast)}>🔄 加载图谱</button>
          </div>
          {graph ? (
            <div>
              <p className="hls-empty">节点 {graph.nodes.length} · 边 {graph.edges.length}</p>
              <ul className="hls-records">
                {graph.nodes.map((n) => (
                  <li key={n.id}>[{n.type}] {n.label}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="hls-empty">点击加载项目知识图谱。</p>
          )}
        </section>
      )}

      {toast && <div className="hls-toast">{toast}</div>}
    </div>
  )
}

function RecordList({ records, preset }: { records: GenerateRecord[]; preset: string }) {
  const mine = records.filter((r) => r.preset === preset)
  if (mine.length === 0) return <p className="hls-empty">暂无记录。</p>
  return (
    <ul className="hls-records">
      {mine.map((r) => (
        <li key={r.taskId}>
          <span className="hls-dot" data-status={r.status} />
          {r.preset} · {r.status}
          {r.draftId ? ` → ${r.draftId}` : ''}
          {r.error ? ` ❌ ${r.error}` : ''}
        </li>
      ))}
    </ul>
  )
}

async function loadGraph(
  setGraph: (g: { nodes: GraphNode[]; edges: GraphEdge[] }) => void,
  setToast: (t: string) => void,
): Promise<void> {
  try {
    setGraph(await api('/graph'))
  } catch (err) {
    setToast(err instanceof Error ? err.message : String(err))
  }
}
