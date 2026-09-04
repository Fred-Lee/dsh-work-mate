import { describe, expect, it } from 'vitest'
import { buildGraph } from './graph.ts'
import type { NoteMeta } from './types.ts'

function doc(id: string, title: string, kind: NoteMeta['kind'], linkedProjects?: string[]): NoteMeta {
  return {
    id,
    title,
    kind,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...(linkedProjects ? { linkedProjects } : {}),
  }
}

describe('buildGraph', () => {
  it('creates service nodes + dependency edges from topology', () => {
    const g = buildGraph({
      topology: {
        services: [
          { id: 'homework-server', name: 'homework-server' },
          { id: 'user-service', name: 'user-service' },
        ],
        dependencies: [{ from: 'homework-server', to: 'user-service', critical: true }],
      },
      documents: [],
    })
    expect(g.nodes.filter((n) => n.type === 'service').length).toBe(2)
    const edge = g.edges.find((e) => e.to === 'svc:user-service')
    expect(edge?.label).toBe('critical')
  })

  it('merges archived documents and links them to projects', () => {
    const g = buildGraph({
      topology: {
        services: [{ id: 'homework-server', name: 'homework-server' }],
        dependencies: [],
      },
      documents: [doc('p1', '批改系统 PRD', 'prd', ['homework-server'])],
    })
    expect(g.nodes.some((n) => n.type === 'prd' && n.label === '批改系统 PRD')).toBe(true)
    expect(g.edges.some((e) => e.label === 'relates to' && e.from === 'doc:p1' && e.to === 'svc:homework-server')).toBe(true)
  })

  it('dedupes nodes by id', () => {
    const g = buildGraph({
      topology: { services: [{ id: 'a', name: 'a' }], dependencies: [{ from: 'a', to: 'a' }] },
      documents: [],
    })
    expect(g.nodes.filter((n) => n.id === 'svc:a').length).toBe(1)
  })
})
