/**
 * Wiki pane (change `wiki-vault-panel`): the vault became useful via tools, a slash
 * command and REST — this is the missing in-UI entry so a human can export, search and
 * see the result without leaving the harness.
 *
 * Everything talks to the plugin's own router under `/workmate/api/…` (same origin as the
 * page), so no extra auth handling is needed.
 */
import { useState } from 'react'

interface Hit {
  file: string
  line: number
  text: string
  score: number
}

interface SearchResult {
  hits?: Hit[]
  scannedFiles?: number
  engine?: string
  note?: string
}

interface ExportResult {
  projectDir?: string
  modules?: number
  pages?: number
  iterations?: number
  classify?: Record<string, unknown>
  git?: { committed?: boolean; note?: string }
  note?: string
}

const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`)
  return JSON.parse(text) as T
}

const row: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 8 }
const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '6px 8px',
  border: '1px solid var(--dsh-border, #444)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
}
const button: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--dsh-border, #444)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
}
const hint: React.CSSProperties = { fontSize: 11, opacity: 0.7, marginBottom: 8 }

export function WikiPanel(): JSX.Element {
  const [projectRoot, setProjectRoot] = useState('')
  const [query, setQuery] = useState('')
  const [semantic, setSemantic] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<SearchResult | undefined>()
  const [exported, setExported] = useState<ExportResult | undefined>()

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <div style={{ padding: 12, fontSize: 13, overflow: 'auto', height: '100%' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>📚 项目 wiki（Obsidian vault）</div>
      <div style={hint}>
        检索返回 <b>文件:行号</b>，可直接引用给 AI；导出把 GitNexus wiki 整理成 vault 笔记（含迭代依赖边）。
      </div>

      <div style={row}>
        <input
          style={input}
          placeholder="项目根目录（绝对路径）"
          value={projectRoot}
          onChange={(event) => setProjectRoot(event.target.value)}
        />
      </div>

      <div style={row}>
        <input
          style={input}
          placeholder="检索关键词，例如：批改并发 / 阅卷锁竞争"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && query.trim() !== '') {
              void run('search', async () => {
                setResult(await post<SearchResult>('/workmate/api/wiki/search', { query, semantic }))
              })
            }
          }}
        />
        <button
          style={button}
          title="关闭时用词法（grep 式）检索；打开则允许本地向量兜底与模型重排"
          onClick={() => setSemantic((value) => !value)}
        >
          {semantic ? '语义' : '词法'}
        </button>
        <button
          style={button}
          disabled={query.trim() === '' || busy !== ''}
          onClick={() =>
            void run('search', async () => {
              setResult(await post<SearchResult>('/workmate/api/wiki/search', { query, semantic }))
            })
          }
        >
          {busy === 'search' ? '检索中…' : '检索'}
        </button>
      </div>

      <div style={row}>
        <button
          style={button}
          disabled={projectRoot.trim() === '' || busy !== ''}
          onClick={() =>
            void run('export', async () => {
              setExported(await post<ExportResult>('/workmate/api/wiki/export', { projectRoot }))
            })
          }
        >
          {busy === 'export' ? '导出中…' : '导出到 vault'}
        </button>
      </div>

      {error !== '' && (
        <div style={{ color: '#e5534b', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{error}</div>
      )}

      {exported !== undefined && (
        <div style={{ borderTop: '1px solid var(--dsh-border, #333)', paddingTop: 8, marginBottom: 8 }}>
          <div>
            ✅ {exported.modules ?? 0} 模块 / {exported.pages ?? 0} 页 / {exported.iterations ?? 0} 迭代
            {exported.git?.committed === true ? '（vault 已提交）' : ''}
          </div>
          {exported.classify !== undefined && (
            <div style={hint}>归类：{JSON.stringify(exported.classify)}</div>
          )}
          {exported.note !== undefined && <div style={hint}>{exported.note}</div>}
          {exported.projectDir !== undefined && <div style={hint}>{exported.projectDir}</div>}
        </div>
      )}

      {result !== undefined && (
        <div>
          <div style={hint}>
            {result.engine ?? '-'} · 命中 {result.hits?.length ?? 0} · 扫描 {result.scannedFiles ?? 0} 篇
            {result.note !== undefined ? ` · ${result.note}` : ''}
          </div>
          {(result.hits ?? []).map((hit) => (
            <div
              key={`${hit.file}:${hit.line}`}
              title="点击复制 文件:行号"
              style={{
                borderTop: '1px solid var(--dsh-border, #333)',
                padding: '6px 0',
                cursor: 'pointer',
              }}
              onClick={() => void navigator.clipboard?.writeText(`${hit.file}:${hit.line}`)}
            >
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {hit.file}:{hit.line}
                {hit.score !== undefined ? `  ·  ${hit.score}` : ''}
              </div>
              <div>{hit.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
