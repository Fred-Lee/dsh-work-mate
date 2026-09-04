/**
 * Helmsman Workbench UI — three mount shapes from one panel body:
 *  - WorkbenchToggle: sidebar.footer.action entry (opens the drawer)
 *  - WorkbenchDrawer: shell.overlay right-side drawer (self-contained chrome)
 *  - App: standalone full-page mount (host-served /helmsman-workbench)
 *
 * Panels show generation records, the DRAFT ARTIFACTS they produced (research
 * notes / PRD drafts — viewable and archivable into the Tolaria vault), and a
 * personal command library (自定义指令) that fills/runs prompts in one click.
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

interface DraftMeta {
  id: string
  kind: string
  mtime: number
  size: number
}

interface CommandItem {
  id: string
  name: string
  prompt: string
  preset?: string
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
  const [drafts, setDrafts] = useState<DraftMeta[]>([])
  const [commands, setCommands] = useState<CommandItem[]>([])
  const [viewDraft, setViewDraft] = useState<{ id: string; content: string } | null>(null)
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const refresh = async (): Promise<void> => {
    try {
      const [r, d, c] = await Promise.all([
        api<{ records: GenerateRecord[] }>('/records'),
        api<{ drafts: DraftMeta[] }>('/drafts'),
        api<{ commands: CommandItem[] }>('/commands'),
      ])
      setRecords(r.records)
      setDrafts(d.drafts)
      setCommands(c.commands)
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 5000)
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

  const viewDraftById = async (id: string): Promise<void> => {
    try {
      const d = await api<{ id: string; content: string }>(`/draft/${encodeURIComponent(id)}`)
      setViewDraft(d)
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }

  const archiveDraft = async (draft: DraftMeta): Promise<void> => {
    const title = window.prompt('归档标题（存入 Tolaria vault）', draft.id)
    if (title === null) return
    try {
      await api('/draft/archive', {
        method: 'POST',
        body: JSON.stringify({ draftId: draft.id, kind: draft.kind, title }),
      })
      setToast(`✅ 已归档到 Tolaria vault: ${title}`)
    } catch (err) {
      setToast(`❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const saveCommands = async (next: CommandItem[]): Promise<void> => {
    try {
      const r = await api<{ commands: CommandItem[] }>('/commands', {
        method: 'POST',
        body: JSON.stringify({ commands: next }),
      })
      setCommands(r.commands)
    } catch (err) {
      setToast(`❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const addCommand = (): void => {
    const name = window.prompt('指令名称（如：竞品分析）')
    if (name === null || name.trim() === '') return
    const prompt = window.prompt('指令提示词（将作为生成输入）')
    if (prompt === null || prompt.trim() === '') return
    void saveCommands([...commands, { id: `cmd-${Date.now().toString(36)}`, name: name.trim(), prompt: prompt.trim(), preset: panel === 'prd' ? 'prd' : 'research' }])
  }

  const visibleDrafts = drafts.filter((d) => panel === 'research' ? d.kind === 'research' : panel === 'prd' ? d.kind === 'prd' : false)
  const visibleCommands = commands.filter((c) => c.preset === undefined || c.preset === panel)

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
          {visibleCommands.length > 0 && (
            <CommandChips
              commands={visibleCommands}
              onPick={(c) => { setPrompt(c.prompt); void runGenerate(c.preset === 'prd' ? 'prd' : 'research') }}
              onAdd={addCommand}
              onRemove={(id) => void saveCommands(commands.filter((c) => c.id !== id))}
            />
          )}
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
          <DraftList drafts={visibleDrafts} onView={(id) => void viewDraftById(id)} onArchive={(d) => void archiveDraft(d)} />
        </section>
      )}

      {panel === 'prd' && (
        <section className="hls-panel">
          <h3>📋 PRD 生成</h3>
          {visibleCommands.length > 0 && (
            <CommandChips
              commands={visibleCommands}
              onPick={(c) => { setPrompt(c.prompt); void runGenerate(c.preset === 'research' ? 'research' : 'prd') }}
              onAdd={addCommand}
              onRemove={(id) => void saveCommands(commands.filter((c) => c.id !== id))}
            />
          )}
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
          <DraftList drafts={visibleDrafts} onView={(id) => void viewDraftById(id)} onArchive={(d) => void archiveDraft(d)} />
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
            <p className="hls-empty">点击加载项目知识图谱（拓扑服务 + 已归档文档）。</p>
          )}
        </section>
      )}

      {viewDraft !== null && (
        <div className="hls-modal" onClick={() => setViewDraft(null)}>
          <div className="hls-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="hls-modal-head">
              <strong>{viewDraft.id}</strong>
              <button type="button" className="hls-close" onClick={() => setViewDraft(null)}>✕</button>
            </div>
            <pre className="hls-modal-pre">{viewDraft.content}</pre>
          </div>
        </div>
      )}

      {toast && <div className="hls-toast">{toast}</div>}
    </div>
  )
}

function CommandChips({ commands, onPick, onAdd, onRemove }: {
  commands: CommandItem[]
  onPick: (c: CommandItem) => void
  onAdd: () => void
  onRemove: (id: string) => void
}): React.ReactNode {
  return (
    <div className="hls-chips">
      {commands.map((c) => (
        <span key={c.id} className="hls-chip">
          <button type="button" className="hls-chip-btn" title={c.prompt} onClick={() => onPick(c)}>
            {c.name}
          </button>
          <button type="button" className="hls-chip-x" aria-label={`删除指令 ${c.name}`} onClick={() => onRemove(c.id)}>✕</button>
        </span>
      ))}
      <button type="button" className="hls-chip-add" onClick={onAdd}>＋ 指令</button>
    </div>
  )
}

function RecordList({ records, preset }: { records: GenerateRecord[]; preset: string }) {
  const mine = records.filter((r) => r.preset === preset)
  if (mine.length === 0) return null
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

function DraftList({ drafts, onView, onArchive }: {
  drafts: DraftMeta[]
  onView: (id: string) => void
  onArchive: (d: DraftMeta) => void
}): React.ReactNode {
  if (drafts.length === 0) return <p className="hls-empty">暂无草稿。生成后在此查看与归档。</p>
  return (
    <div>
      <h4 className="hls-sub">📄 草稿（确认归档后进入 Tolaria 知识库）</h4>
      <ul className="hls-records">
        {drafts.map((d) => (
          <li key={d.id} className="hls-draft-row">
            <span className="hls-draft-id" title={d.id}>{d.id}</span>
            <span className="hls-draft-actions">
              <button type="button" className="hls-mini" onClick={() => onView(d.id)}>查看</button>
              <button type="button" className="hls-mini" onClick={() => onArchive(d)}>✅ 归档</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
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
