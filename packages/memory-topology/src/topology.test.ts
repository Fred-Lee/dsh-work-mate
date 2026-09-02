import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTopology, normalizeTopology } from './types.ts'
import { TopologyStore } from './store.ts'
import { applyPreview, previewCompose, previewKubernetes } from './import.ts'

describe('normalizeTopology', () => {
  it('fills defaults and drops malformed parts', () => {
    const t = normalizeTopology({ projectGroupId: 'g1', services: { s1: { name: 42 }, bad: 'nope' } })
    expect(t.projectGroupId).toBe('g1')
    expect(t.services['s1']?.name).toBe('42')
    expect(t.services['bad']).toBeUndefined()
    expect(t.defaultBranch).toBe('main')
  })
})

describe('TopologyStore', () => {
  let dir: string
  let store: TopologyStore

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmsman-topo-'))
    store = new TopologyStore({ rootDir: dir })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('save → list → load → delete round trip (CJK group names)', async () => {
    const t = emptyTopology('订单中台')
    t.services['order-service'] = { name: 'order-service', projectId: 'p1', techStack: ['Java 17'], apiEndpoints: [] }
    await store.save(t)

    expect(await store.listGroups()).toEqual(['订单中台'])
    const loaded = await store.load('订单中台')
    expect(loaded?.services['order-service']?.name).toBe('order-service')

    expect(await store.delete('订单中台')).toBe(true)
    expect(await store.listGroups()).toEqual([])
  })

  it('corrupted file degrades to null, never throws', async () => {
    await store.save(emptyTopology('broken'))
    writeFileSync(join(dir, 'broken.json'), '{ not valid json')
    expect(await store.load('broken')).toBeNull()
  })
})

describe('importers', () => {
  it('previews docker-compose and infers dependencies', () => {
    const preview = previewCompose(`
services:
  api-gateway:
    image: nginx:latest
    depends_on:
      - user-service
  user-service:
    image: user-service:1.2.0
  redis:
    image: redis:7.0
`)
    expect(preview.services.map((s) => s.name)).toEqual(['api-gateway', 'user-service', 'redis'])
    expect(preview.services.find((s) => s.name === 'redis')?.selected).toBe(false)
    expect(preview.dependencies).toEqual([{ from: 'api-gateway', to: 'user-service', method: 'DEPENDS_ON', endpoints: [] }])
  })

  it('previews kubernetes deployments', () => {
    const preview = previewKubernetes(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
        - image: order-service:1.0
`)
    expect(preview.services).toHaveLength(1)
    expect(preview.services[0]).toMatchObject({ name: 'order-service', image: 'order-service:1.0' })
  })

  it('applies preview onto a topology', () => {
    const t = emptyTopology('g')
    const preview = previewCompose(`
services:
  user-service:
    image: u:1
    depends_on:
      - order-service
  order-service:
    image: o:1
`)
    applyPreview(t, preview)
    expect(Object.keys(t.services)).toEqual(['user-service', 'order-service'])
    expect(t.restDependencies['user-service']).toEqual([
      { toServiceId: 'order-service', endpoints: [], method: 'DEPENDS_ON' },
    ])
  })
})
