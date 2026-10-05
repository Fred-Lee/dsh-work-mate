import { describe, expect, it } from 'vitest'
import { parseSwarmTasks, planSwarm, scopesIntersect } from './plan.ts'

describe('parseSwarmTasks', () => {
  it('derives id, title and write scopes from tasks.md lines', () => {
    const tasks = parseSwarmTasks(
      [
        '# Tasks',
        '',
        '- [x] 1. 已完成的事',
        '- [ ] 2. 拆分计费模块 <!-- writes: src/billing/**, docs/billing.md -->',
        '- [ ] 3. 无关任务',
        'not a task',
      ].join('\n'),
    )

    expect(tasks).toHaveLength(3)
    expect(tasks[1]).toEqual({
      id: 't2',
      title: '2. 拆分计费模块',
      writes: ['src/billing/**', 'docs/billing.md'],
    })
    expect(tasks[0]?.writes).toEqual([])
    expect(tasks[2]?.title).toBe('3. 无关任务')
  })

  it('keeps task ids stable in file order', () => {
    expect(parseSwarmTasks('- [ ] a\n- [ ] b\n- [x] c\n').map((task) => task.id)).toEqual(['t1', 't2', 't3'])
  })
})

describe('scopesIntersect', () => {
  it('treats a subtree as covering its children', () => {
    expect(scopesIntersect('src/billing/**', 'src/billing/invoice.ts')).toBe(true)
    expect(scopesIntersect('src/billing', 'src/billing/invoice.ts')).toBe(true)
  })

  it('separates sibling subtrees and unrelated files', () => {
    expect(scopesIntersect('src/billing/**', 'src/orders/**')).toBe(false)
    expect(scopesIntersect('src/a.ts', 'src/b.ts')).toBe(false)
  })

  it('never matches an empty scope', () => {
    expect(scopesIntersect('', 'src/a.ts')).toBe(false)
    expect(scopesIntersect('src/a.ts', '')).toBe(false)
  })
})

describe('planSwarm', () => {
  const task = (id: string, writes: string[]) => ({ id, title: id, writes })

  it('never puts two tasks with intersecting scopes in one batch', () => {
    const plan = planSwarm([
      task('t1', ['src/billing/**']),
      task('t2', ['src/billing/invoice.ts']),
      task('t3', ['src/orders/**']),
    ])

    expect(plan.conflicts).toEqual([{ a: 't1', b: 't2', scope: 'src/billing/**' }])
    const batchOf = (id: string): number => plan.batches.findIndex((batch) => batch.tasks.includes(id))
    expect(batchOf('t1')).not.toBe(batchOf('t2'))
    expect(batchOf('t3')).toBe(batchOf('t1'))
  })

  it('keeps undeclared tasks parallel but flags them', () => {
    const plan = planSwarm([task('t1', []), task('t2', []), task('t3', [])], { maxParallel: 3 })

    expect(plan.batches).toEqual([{ index: 0, tasks: ['t1', 't2', 't3'] }])
    expect(plan.undeclared).toEqual(['t1', 't2', 't3'])
  })

  it('honours maxParallel and spills into further batches', () => {
    const plan = planSwarm([task('t1', []), task('t2', []), task('t3', []), task('t4', [])], { maxParallel: 2 })

    expect(plan.batches.map((batch) => batch.tasks)).toEqual([
      ['t1', 't2'],
      ['t3', 't4'],
    ])
  })

  it('serializes a fully conflicting set', () => {
    const shared = ['src/shared/**']
    const plan = planSwarm([task('t1', shared), task('t2', shared), task('t3', shared)])

    expect(plan.batches.map((batch) => batch.tasks)).toEqual([['t1'], ['t2'], ['t3']])
    expect(plan.conflicts).toHaveLength(3)
  })

  it('clamps a nonsensical maxParallel to one per batch', () => {
    const plan = planSwarm([task('t1', []), task('t2', [])], { maxParallel: 0 })

    expect(plan.batches.map((batch) => batch.tasks)).toEqual([['t1'], ['t2']])
  })
})
