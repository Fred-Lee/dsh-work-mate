/**
 * GraphView — a readable layered view over /workmate/api/graph.
 *
 * Active proposals only by default: the old view drew every archived proposal,
 * repeated project nodes and a text label on every edge, which made the graph
 * unreadable at 1440px. Now: one node per project/commit, no per-edge text,
 * dynamic columns and full labels in a title tooltip.
 */
import { useCallback, useEffect, useState } from 'react'
import { Btn } from './controls'
import type { GraphPayload } from './graph-types'

const NODE_W = 180
const NODE_H = 28
const COL_GAP = 64
const ROW_GAP = 12
const LEFT = 16
const TOP = 34

interface Positioned {
  id: string
  label: string
  status?: string
  kind: GraphPayload['nodes'][number]['kind']
  x: number
  y: number
}

const KIND_FILL: Record<GraphPayload['nodes'][number]['kind'], string> = {
  proposal: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  project: 'var(--dsw-alias-bg-module-platform, #f5f6f7)',
  commit: 'var(--dsw-alias-bg-layer-1, #ffffff)',
}
const KIND_STROKE: Record<GraphPayload['nodes'][number]['kind'], string> = {
  proposal: 'var(--dsw-alias-border-l3, #00000029)',
  project: 'var(--dsw-alias-border-l2, #0000001a)',
  commit: 'var(--dsw-alias-border-l2, #0000001a)',
}
const KIND_LABEL: Record<GraphPayload['nodes'][number]['kind'], string> = {
  proposal: '提案',
  project: '项目',
  commit: 'Git 提交',
}

export function GraphView(props: { projectRoot?: string; showArchived?: boolean }): JSX.Element {
  const { projectRoot, showArchived = false } = props
  const [graph, setGraph] = useState<GraphPayload | undefined>(undefined)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      // scope=all 由服务端决定是否返回归档节点；缺省只返回活跃提案。
      // 不用模板拼接：URLSearchParams 负责编码，也让「只带 projectRoot」保持原样。
      const params = new URLSearchParams()
      if (projectRoot !== undefined && projectRoot !== '') params.set('projectRoot', projectRoot)
      if (showArchived) params.set('scope', 'all')
      const suffix = params.toString() === '' ? '' : `?${params.toString()}`
      const response = await fetch(`/workmate/api/graph${suffix}`)
      const body = (await response.json()) as GraphPayload
      if (!response.ok) throw new Error('graph API failed')
      setGraph(body)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectRoot, showArchived])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 三处（正常/错误/空态）共用一个入口，标签统一：图谱没有别的刷新途径，
  // 归档一批提案后必须能就地重取，而不是靠切走再切回触发重新挂载。
  const refreshButton = (
    <Btn size="sm" type="button" onClick={() => void refresh()}>
      刷新
    </Btn>
  )

  if (error !== '') {
    return (
      <div className="wm-error wm-graph-state" role="alert">
        <span>{error}</span>
        {refreshButton}
      </div>
    )
  }
  if (graph === undefined) return <div className="wm-empty">加载中…</div>

  const proposals = graph.nodes.filter((node) => node.kind === 'proposal')
  const shown = showArchived ? proposals : proposals.filter((node) => node.status !== 'archived')
  if (shown.length === 0) {
    // 缺省请求下服务端本就不返回归档提案——不能靠客户端数「有几条归档」来解释空态，
    // 只能说清「默认不含归档」并指出开关在哪。
    return (
      <div className="wm-empty wm-graph-state">
        <span>
          {showArchived ? '还没有提案关联 — 图谱为空。' : '还没有活跃提案关联 — 归档提案默认不进入图谱，点顶部「显示已归档」查看。'}
        </span>
        {refreshButton}
      </div>
    )
  }

  // Client-side guard: an older host may still return archived proposals.
  const proposalNodeIds = new Set(
    graph.nodes
      .filter((node) => node.kind === 'proposal' && (showArchived || node.status !== 'archived'))
      .map((node) => node.id),
  )
  const visibleIds = new Set<string>(proposalNodeIds)
  let grew = true
  while (grew) {
    grew = false
    for (const edge of graph.edges) {
      if (visibleIds.has(edge.from) && !visibleIds.has(edge.to)) {
        visibleIds.add(edge.to)
        grew = true
      }
    }
  }
  const activeEdges = graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
  const seen = new Set<string>()
  const visibleNodes = graph.nodes.filter((node) => {
    if (!visibleIds.has(node.id) || seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
  const kinds = (['proposal', 'project', 'commit'] as const).filter((kind) => visibleNodes.some((node) => node.kind === kind))
  const groups = kinds.map((kind) => visibleNodes.filter((node) => node.kind === kind))
  const maxCount = Math.max(...groups.map((group) => group.length))
  const positions = new Map<string, Positioned>()
  groups.forEach((group, column) => {
    const x = LEFT + column * (NODE_W + COL_GAP)
    const groupHeight = group.length * (NODE_H + ROW_GAP) - ROW_GAP
    const offset = Math.max(0, (maxCount * (NODE_H + ROW_GAP) - ROW_GAP - groupHeight) / 2)
    group.forEach((node, index) => {
      positions.set(node.id, { ...node, x, y: TOP + offset + index * (NODE_H + ROW_GAP) })
    })
  })
  const edges = activeEdges
    .map((edge) => {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      return from !== undefined && to !== undefined ? { from, to } : undefined
    })
    .filter((edge): edge is { from: Positioned; to: Positioned } => edge !== undefined)
  const width = LEFT + kinds.length * (NODE_W + COL_GAP)
  const height = TOP + maxCount * (NODE_H + ROW_GAP) + 12

  return (
    <div className="wm-graph">
      {/* 绝对定位按钮的容器：只能在 .wm-graph（position:relative）里用；
          错误态/空态没有这个祖先，改用 wm-graph-state 的流内布局。 */}
      <div className="wm-graph-refresh">{refreshButton}</div>
      <div className="wm-graph-head">
        {kinds.map((kind, column) => (
          <span key={kind} className="wm-graph-col-label" style={{ left: LEFT + column * (NODE_W + COL_GAP) }}>
            {KIND_LABEL[kind]} · {groups[column]?.length ?? 0}
          </span>
        ))}
      </div>
      <svg width={width} height={height} role="img" aria-label={showArchived ? '知识图谱：提案、项目与提交' : '知识图谱：活跃提案、项目与提交'}>
        <defs>
          {[...positions.values()].map((node, index) => (
            <clipPath key={node.id} id={`wm-graph-clip-${index}`}>
              <rect x={node.x + 6} y={node.y} width={NODE_W - 12} height={NODE_H} rx={5} />
            </clipPath>
          ))}
        </defs>
        {edges.map((edge, index) => {
          const x1 = edge.from.x + NODE_W
          const y1 = edge.from.y + NODE_H / 2
          const x2 = edge.to.x
          const y2 = edge.to.y + NODE_H / 2
          const mid = (x1 + x2) / 2
          return (
            <path
              key={index}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="var(--dsw-alias-border-l1, #d0d7de)"
              strokeWidth={1.4}
            />
          )
        })}
        {[...positions.values()].map((node, index) => {
          const label = node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label
          return (
            <g key={node.id} clipPath={`url(#wm-graph-clip-${index})`}>
              <rect x={node.x} y={node.y} width={NODE_W} height={NODE_H} rx={7} fill={KIND_FILL[node.kind]} stroke={KIND_STROKE[node.kind]} />
              <text x={node.x + 8} y={node.y + NODE_H / 2 + 4} fontSize={12} fill="var(--dsw-alias-label-primary, #1f2328)">
                <title>{node.label}</title>
                {label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
