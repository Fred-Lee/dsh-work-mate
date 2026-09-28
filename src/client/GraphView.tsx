/**
 * GraphView — three-column layered SVG (proposals / projects / commits) over
 * /workmate/api/graph. Hand-drawn SVG instead of a charting library (design
 * D1 of the change): the acceptance bar is "3 layers of association", not
 * force-directed eye candy, and this keeps the bundle dependency-free.
 */
import { useCallback, useEffect, useState } from 'react'
import type { GraphPayload } from './graph-types'

const NODE_W = 132
const NODE_H = 26
const COL_X = [16, 210, 404]
const GAP = 14

interface Positioned {
  id: string
  label: string
  status?: string
  kind: GraphPayload['nodes'][number]['kind']
  x: number
  y: number
}

const KIND_FILL: Record<GraphPayload['nodes'][number]['kind'], string> = {
  proposal: '#ddf4ff',
  project: '#dafbe1',
  commit: '#eaeef2',
}
const KIND_STROKE: Record<GraphPayload['nodes'][number]['kind'], string> = {
  proposal: '#54aeff',
  project: '#4ac26b',
  commit: '#afb8c1',
}
const COL_LABEL = ['提案', '项目', 'Git 提交']

function layout(graph: GraphPayload): { nodes: Positioned[]; edges: Array<{ from: Positioned; to: Positioned; relation: string }>; height: number } {
  const byKind = (kind: GraphPayload['nodes'][number]['kind']) => graph.nodes.filter((node) => node.kind === kind)
  const groups = [byKind('proposal'), byKind('project'), byKind('commit')]
  const nodes: Positioned[] = []

  groups.forEach((group, column) => {
    const height = group.length * (NODE_H + GAP) - GAP
    group.forEach((node, index) => {
      nodes.push({
        ...node,
        x: COL_X[column] as number,
        y: Math.max(0, height / 2 - (group.length * (NODE_H + GAP) - GAP) / 2) + index * (NODE_H + GAP),
      })
    })
  })

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = graph.edges
    .map((edge) => {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      return from && to ? { from, to, relation: edge.relation } : undefined
    })
    .filter((edge): edge is { from: Positioned; to: Positioned; relation: string } => edge !== undefined)

  const maxCount = Math.max(1, ...groups.map((group) => group.length))
  return { nodes, edges, height: 46 + maxCount * (NODE_H + GAP) }
}

export function GraphView(props: { projectRoot?: string }): JSX.Element {
  const { projectRoot } = props
  const [graph, setGraph] = useState<GraphPayload | undefined>(undefined)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const query = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
      const response = await fetch(`/workmate/api/graph${query}`)
      const body = (await response.json()) as GraphPayload
      if (!response.ok) throw new Error('graph API failed')
      setGraph(body)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectRoot])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (error !== '') return <div className="wm-error">{error}</div>
  if (graph === undefined) return <div className="wm-empty">加载中…</div>
  if (graph.nodes.length === 0)
    return <div className="wm-empty">还没有可展示的关联 — 先创建提案并关联项目。</div>

  const { nodes, edges, height } = layout(graph)

  return (
    <div className="wm-graph">
      {COL_LABEL.map((label, column) => (
        <div key={label} className="wm-graph-col-label" style={{ left: (COL_X[column] as number) + 2 }}>
          {label}
        </div>
      ))}
      <svg width={COL_X[2]! + NODE_W + 16} height={height} role="img" aria-label="知识图谱">
        {edges.map((edge, index) => {
          const x1 = edge.from.x + NODE_W
          const y1 = edge.from.y + NODE_H / 2
          const x2 = edge.to.x
          const y2 = edge.to.y + NODE_H / 2
          const midX = (x1 + x2) / 2
          return (
            <g key={index}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d0d7de" strokeWidth={1.4} />
              <text x={midX} y={(y1 + y2) / 2 - 3} textAnchor="middle" fontSize={10} fill="#57606a">
                {edge.relation}
              </text>
            </g>
          )
        })}
        {nodes.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={NODE_W}
              height={NODE_H}
              rx={7}
              fill={KIND_FILL[node.kind]}
              stroke={KIND_STROKE[node.kind]}
            />
            <text
              x={node.x + NODE_W / 2}
              y={node.y + NODE_H / 2 + 4}
              textAnchor="middle"
              fontSize={11}
              fill="#1f2328"
            >
              {node.label.length > 15 ? `${node.label.slice(0, 14)}…` : node.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
