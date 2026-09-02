/**
 * Helmsman Diff View — PRD §4.3.2 / §4.6:
 * 三种视图模式 (split / unified / side-by-side), 行级交互 (悬停评论, 行号复制),
 * ⚡ 冲突标注与方案选择, 单 Agent 合并 / 部分合并 / 全部放弃。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AGENT_LABELS, api, parseHunks, type DiffLine, type DiffTaskPayload, type FileDiff } from './api'

type ViewMode = 'split' | 'unified' | 'side-by-side'

interface Comment {
  agent: string
  file: string
  line: number
  body: string
}

const COMMENTS_KEY = 'helmsman.diffComments'

function loadComments(): Comment[] {
  try {
    return JSON.parse(localStorage.getItem(COMMENTS_KEY) ?? '[]') as Comment[]
  } catch {
    return []
  }
}

export function App() {
  const [taskId, setTaskId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('task'))
  const [tasks, setTasks] = useState<Array<{ id: string; prompt: string; status: string }>>([])
  const [task, setTask] = useState<DiffTaskPayload | null>(null)
  const [mode, setMode] = useState<ViewMode>('split')
  const [file, setFile] = useState<string | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<Record<string, boolean>>({})
  const [conflictChoice, setConflictChoice] = useState<Record<string, string>>({})
  const [comments, setComments] = useState<Comment[]>(loadComments)
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [merging, setMerging] = useState(false)

  useEffect(() => {
    void api
      .listTasks()
      .then((res) => {
        setTasks(res.tasks)
        if (!taskId && res.tasks.length > 0) setTaskId(res.tasks[0]!.id)
      })
      .catch((err) => setToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  }, [taskId])

  useEffect(() => {
    if (!taskId) return
    void api
      .getTask(taskId)
      .then((res) => {
        if (res.found && res.task) setTask(res.task)
      })
      .catch((err) => setToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  }, [taskId, merging])

  useEffect(() => {
    if (!toast) return
    if (toast.kind === 'error') return // error 需手动关闭 (PRD §4.5)
    const id = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(id)
  }, [toast])

  const completedAgents = useMemo(
    () => Object.entries(task?.agents ?? {}).filter(([, a]) => a.state === 'completed'),
    [task],
  )

  // union of changed files across completed agents
  const filesByAgent = useMemo(() => {
    const map = new Map<string, Array<FileDiff>>()
    for (const [agent, a] of completedAgents) map.set(agent, a.diffs)
    return map
  }, [completedAgents])

  const allFiles = useMemo(() => {
    const set = new Set<string>()
    for (const diffs of filesByAgent.values()) for (const f of diffs) set.add(f.path)
    return [...set].sort()
  }, [filesByAgent])

  const conflictingFiles = useMemo(() => {
    const counts = new Map<string, number>()
    for (const diffs of filesByAgent.values()) for (const f of diffs) counts.set(f.path, (counts.get(f.path) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p))
  }, [filesByAgent])

  const currentFile = file ?? allFiles[0] ?? null

  const addComment = useCallback((agent: string, file2: string, line: number, body: string) => {
    setComments((prev) => {
      const next = [...prev, { agent, file: file2, line, body }]
      localStorage.setItem(COMMENTS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const doMerge = async (agents: string[], files: string[] | undefined, discardAfterMerge = false): Promise<void> => {
    if (!taskId) return
    setMerging(true)
    try {
      const res = await api.merge(taskId, { agents, files, discardAfterMerge })
      const failed = res.results.filter((r) => !r.ok)
      if (failed.length > 0) {
        setToast({ kind: 'error', text: `合并失败: ${failed.map((r) => `${r.agent}: ${r.message}`).join('; ')}` })
      } else {
        setToast({ kind: 'success', text: `✅ 合并成功 (${res.results.filter((r) => r.committed).length} 个 agent 已提交)` })
      }
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setMerging(false)
    }
  }

  if (!taskId || !task) {
    return (
      <div className="diff-app">
        <p className="muted" style={{ padding: 24 }}>
          {tasks.length === 0 ? '暂无可对比的任务 — 先在 Dashboard 执行一个并行任务。' : '加载中…'}
        </p>
      </div>
    )
  }

  return (
    <div className="diff-app">
      <header className="diff-topbar">
        <a className="btn btn-sm" href="/helmsman-dashboard/">← 返回</a>
        <span className="diff-title">
          任务: “{task.prompt.slice(0, 48)}{task.prompt.length > 48 ? '…' : ''}”
        </span>
        <span className="muted small">📁 涉及 {allFiles.length} 个文件</span>
        <select value={task.id} onChange={(e) => setTaskId(e.target.value)} aria-label="切换任务">
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>{t.id} — {t.prompt.slice(0, 30)}</option>
          ))}
        </select>
        <div className="mode-switch" role="tablist">
          {(['split', 'unified', 'side-by-side'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={`mode-btn ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
              {m === 'split' ? '左右并排' : m === 'unified' ? '统一格式' : '多 Agent 并排'}
            </button>
          ))}
        </div>
      </header>

      <div className="agent-chips">
        {Object.entries(task.agents).map(([agent, a]) => (
          <span key={agent} className={`chip chip-${a.state}`}>
            {AGENT_LABELS[agent] ?? agent}
            {a.stats && <em> [+{a.stats.additions}/-{a.stats.deletions}]</em>}
            {a.state !== 'completed' && <em> ({a.state})</em>}
          </span>
        ))}
      </div>

      <div className="diff-body">
        <nav className="file-list" aria-label="变更文件列表">
          {allFiles.map((f) => (
            <label key={f} className={`file-item ${f === currentFile ? 'active' : ''}`}>
              <input
                type="checkbox"
                checked={selectedFiles[f] !== false}
                onChange={(e) => setSelectedFiles({ ...selectedFiles, [f]: e.target.checked })}
                title="勾选后可用于「合并所选」"
              />
              <button className="file-link" onClick={() => setFile(f)}>
                📄 {f}
                {conflictingFiles.has(f) && <span className="conflict-badge">⚡ 冲突</span>}
              </button>
            </label>
          ))}
          {allFiles.length === 0 && <p className="muted small" style={{ padding: 8 }}>没有已完成的变更</p>}
        </nav>

        <section className="diff-viewer">
          {currentFile && <FileDiffView
            file={currentFile}
            conflicted={conflictingFiles.has(currentFile)}
            filesByAgent={filesByAgent}
            mode={mode}
            conflictChoice={conflictChoice[currentFile] ?? null}
            onChooseConflict={(agent) => setConflictChoice({ ...conflictChoice, [currentFile]: agent })}
            comments={comments.filter((c) => c.file === currentFile)}
            onComment={(agent, line, body) => addComment(agent, currentFile, line, body)}
          />}
        </section>
      </div>

      <footer className="merge-bar">
        {completedAgents.map(([agent]) => (
          <button key={agent} className="btn btn-primary" disabled={merging} onClick={() => void doMerge([agent], undefined, true)}>
            ✅ 合并 {AGENT_LABELS[agent] ?? agent}
          </button>
        ))}
        <button
          className="btn"
          disabled={merging || allFiles.every((f) => selectedFiles[f] === false)}
          onClick={() => {
            // 冲突文件遵循用户选择的「采纳方案」，未冲突文件取所有改过它的 agent
            const chosen: string[] = []
            const files: string[] = []
            for (const f of allFiles) {
              if (selectedFiles[f] === false) continue
              const choice = conflictChoice[f]
              if (choice && !chosen.includes(choice)) chosen.push(choice)
              files.push(f)
            }
            const agentsForFiles = new Set<string>(chosen)
            for (const f of files) {
              for (const [agent, diffs] of filesByAgent) {
                if (diffs.some((d) => d.path === f)) agentsForFiles.add(agent)
              }
            }
            void doMerge([...agentsForFiles], files)
          }}
        >
          🔀 合并所选
        </button>
        <button
          className="btn danger"
          disabled={merging}
          onClick={async () => {
            if (!window.confirm('确认放弃全部 worktree 变更？此操作不可撤销。')) return
            try {
              await api.discard(task.id)
              setToast({ kind: 'info', text: '已放弃全部变更' })
            } catch (err) {
              setToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
            }
          }}
        >
          ❌ 全部放弃
        </button>
      </footer>

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status" onClick={() => toast.kind === 'error' && setToast(null)}>
          {toast.kind === 'error' ? '❌ ' : '✅ '}
          {toast.text}
          {toast.kind === 'error' && <button className="toast-close" onClick={() => setToast(null)}>✕</button>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// per-file diff rendering
// ---------------------------------------------------------------------------

function FileDiffView(props: {
  file: string
  conflicted: boolean
  filesByAgent: Map<string, Array<FileDiff>>
  mode: ViewMode
  conflictChoice: string | null
  onChooseConflict: (agent: string) => void
  comments: Array<{ agent: string; file: string; line: number; body: string }>
  onComment: (agent: string, line: number, body: string) => void
}) {
  const { file, conflicted, filesByAgent, mode, conflictChoice, onChooseConflict, comments, onComment } = props
  const agentDiffs = [...filesByAgent.entries()]
    .map(([agent, diffs]) => ({ agent, diff: diffs.find((d) => d.path === file) }))
    .filter((e) => e.diff != null) as Array<{ agent: string; diff: FileDiff }>

  if (agentDiffs.length === 0) return <p className="muted">该文件暂无已完成 Agent 的变更。</p>

  return (
    <div className="file-diff">
      <header className="file-head">
        <h4>📄 {file}</h4>
        {conflicted && (
          <div className="conflict-box" role="dialog" aria-label="代码冲突">
            <strong>⚡ 代码冲突（{agentDiffs.length} 个 Agent 修改了此文件）</strong>
            <div className="conflict-options">
              {agentDiffs.map(({ agent, diff }) => (
                <label key={agent} className="radio">
                  <input
                    type="radio"
                    name={`conflict-${file}`}
                    checked={conflictChoice === agent}
                    onChange={() => onChooseConflict(agent)}
                  />
                  采用 {AGENT_LABELS[agent] ?? agent} 的方案 (+{diff.additions}/-{diff.deletions})
                </label>
              ))}
              <label className="radio">
                <input type="radio" name={`conflict-${file}`} checked={conflictChoice == null} onChange={() => onChooseConflict('')} />
                手动编辑（暂保留全部，合并时再决定）
              </label>
            </div>
          </div>
        )}
      </header>

      {mode === 'unified' && <UnifiedView diff={agentDiffs[0]!.diff.diff} comments={comments} onComment={(line, body) => onComment(agentDiffs[0]!.agent, line, body)} />}
      {mode === 'split' && <SplitView left={agentDiffs[0]!} right={agentDiffs[1] ?? null} />}
      {mode === 'side-by-side' && <MultiAgentView agentDiffs={agentDiffs} />}

      <p className="legend">
        Legend: <span className="lg lg-ctx">─── 共同</span> <span className="lg lg-add">+ 新增</span>{' '}
        <span className="lg lg-del">- 删除</span> <span className="lg lg-conf">~ 冲突</span>
      </p>
    </div>
  )
}

function useCopyLine(): (text: string) => void {
  return useCallback((text: string) => {
    void navigator.clipboard?.writeText(text)
  }, [])
}

function UnifiedView({ diff, comments, onComment }: { diff: string; comments: Array<{ line: number; body: string }>; onComment: (line: number, body: string) => void }) {
  const copy = useCopyLine()
  const [hoverLine, setHoverLine] = useState<number | null>(null)
  const [commentFor, setCommentFor] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const lines = parseHunks(diff)
  return (
    <div className="code-block unified">
      {lines.map((l, i) => (
        <DiffRow
          key={i}
          line={l}
          showComment={l.kind === 'add' || l.kind === 'del'}
          hovered={hoverLine === i}
          comment={comments.find((c) => c.line === (l.newNo ?? l.oldNo ?? -1))}
          onHover={(v) => setHoverLine(v ? i : null)}
          onCopy={() => copy(l.text)}
          onOpenComment={() => {
            setCommentFor(i)
            setDraft('')
          }}
          commentOpen={commentFor === i}
          draft={draft}
          onDraft={setDraft}
          onSubmitComment={() => {
            const no = lines[i]?.newNo ?? lines[i]?.oldNo
            if (no != null && draft.trim()) onComment(no, draft.trim())
            setCommentFor(null)
          }}
        />
      ))}
    </div>
  )
}

interface DiffRowProps {
  line: DiffLine
  showComment: boolean
  hovered: boolean
  comment?: { line: number; body: string }
  onHover: (v: boolean) => void
  onCopy: () => void
  onOpenComment?: () => void
  commentOpen?: boolean
  draft?: string
  onDraft?: (v: string) => void
  onSubmitComment?: () => void
}

function DiffRow(props: DiffRowProps) {
  const { line, hovered, comment, onHover, onCopy, onOpenComment, commentOpen, draft, onDraft, onSubmitComment } = props
  const cls = line.kind === 'add' ? 'row-add' : line.kind === 'del' ? 'row-del' : line.kind === 'hunk' ? 'row-hunk' : line.kind === 'meta' ? 'row-meta' : ''
  return (
    <>
      <div
        className={`code-row ${cls} ${hovered ? 'hovered' : ''}`}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
      >
        <span className="ln" title="点击复制该行" onClick={onCopy}>{line.oldNo ?? ''}</span>
        <span className="ln" title="点击复制该行" onClick={onCopy}>{line.newNo ?? ''}</span>
        <code>{line.text}</code>
        {hovered && props.showComment && onOpenComment && (
          <button className="comment-btn" title="添加评论" onClick={onOpenComment}>💬</button>
        )}
      </div>
      {comment && <div className="line-comment">💬 <strong>{comment.line}行评论:</strong> {comment.body}</div>}
      {commentOpen && onDraft && onSubmitComment && (
        <div className="line-comment-input">
          <textarea rows={2} value={draft} placeholder="输入评论（支持 Markdown）…" onChange={(e) => onDraft(e.target.value)} />
          <button className="btn btn-sm btn-primary" onClick={onSubmitComment}>提交评论</button>
        </div>
      )}
    </>
  )
}

function SplitView({ left, right }: { left: { agent: string; diff: FileDiff }; right: { agent: string; diff: FileDiff } | null }) {
  return (
    <div className="split-view">
      <SplitPane agent={left.agent} diff={left.diff} side="left" />
      {right ? <SplitPane agent={right.agent} diff={right.diff} side="right" /> : <div className="split-pane empty">（无第二个 Agent 的变更）</div>}
    </div>
  )
}

function SplitPane({ agent, diff }: { agent: string; diff: FileDiff; side: string }) {
  const lines = parseHunks(diff.diff)
  return (
    <div className="split-pane">
      <div className="split-pane-head">{AGENT_LABELS[agent] ?? agent} [+{diff.additions}/-{diff.deletions}]</div>
      <div className="code-block">
        {lines.map((l, i) => (
          <div key={i} className={`code-row ${l.kind === 'add' ? 'row-add' : l.kind === 'del' ? 'row-del' : l.kind === 'hunk' ? 'row-hunk' : l.kind === 'meta' ? 'row-meta' : ''}`}>
            <span className="ln">{l.oldNo ?? l.newNo ?? ''}</span>
            <code>{l.text}</code>
          </div>
        ))}
      </div>
    </div>
  )
}

function MultiAgentView({ agentDiffs }: { agentDiffs: Array<{ agent: string; diff: FileDiff }> }) {
  return (
    <div className="multi-agent" style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(agentDiffs.length, 4)}, 1fr)`, gap: 8 }}>
      {agentDiffs.slice(0, 4).map(({ agent, diff }) => (
        <SplitPane key={agent} agent={agent} diff={diff} side="multi" />
      ))}
    </div>
  )
}
