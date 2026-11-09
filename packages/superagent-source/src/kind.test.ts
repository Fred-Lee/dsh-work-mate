import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KIND,
  DESCRIPTION,
  FIELDS,
  POLICY_EXPLICIT,
  POLICY_FIELDS,
  TITLE,
  factsOf,
  kindIdOf,
  kindMetadataShape,
  policyRows,
  policySchema,
  titleOf,
  validateConfig,
  workmateConfigSchema,
} from './kind.ts'

describe('workmateConfigSchema', () => {
  it('parse({}) 不抛（Super-agent 的 resolve 会在坏配置上回落到 parse({})）', () => {
    expect(() => workmateConfigSchema.parse({})).not.toThrow()
  })

  it('默认值符合规格', () => {
    const parsed = workmateConfigSchema.parse({ taskFile: '/tmp/tasks.json' })
    // 实例 id 不由设置决定（注册先于设置），设置里的 kind 只是可选的一致性校验值。
    expect(parsed.kind).toBeUndefined()
    expect(parsed.repos).toEqual([])
    expect(parsed.pollSeconds).toBe(5)
    expect(parsed.maxPerScan).toBe(5)
    expect(parsed.maxRowsPerTask).toBe(200)
    expect(parsed.interactive).toBe(false)
    expect(parsed.copyFiles).toEqual(['.env', '.env.local'])
    expect(parsed.openspecRoot).toBe('openspec')
    expect(parsed.repoRoot).toBeUndefined()
  })

  it('设置里的 kind 可选，但填了就必须合规', () => {
    expect(workmateConfigSchema.parse({ taskFile: '/a', kind: 'workmate-b' }).kind).toBe('workmate-b')
    for (const kind of ['Workmate', '1workmate', 'work_mate', 'workmate b', '']) {
      expect(workmateConfigSchema.safeParse({ taskFile: '/a', kind }).success).toBe(false)
    }
  })

  it('repos 接受绝对路径数组；面板文本框写的逗号/换行分隔字符串归一成数组', () => {
    expect(workmateConfigSchema.parse({ taskFile: '/a', repos: ['/srv/a', '/srv/b/'] }).repos).toEqual([
      '/srv/a',
      '/srv/b/',
    ])
    expect(workmateConfigSchema.parse({ taskFile: '/a', repos: '/srv/a, /srv/b' }).repos).toEqual([
      '/srv/a',
      '/srv/b',
    ])
    expect(workmateConfigSchema.parse({ taskFile: '/a', repos: '/srv/a\n/srv/b\n' }).repos).toEqual(['/srv/a', '/srv/b'])
    expect(workmateConfigSchema.parse({ taskFile: '/a', repos: ' , ' }).repos).toEqual([])
    expect(workmateConfigSchema.safeParse({ taskFile: '/a', repos: [''] }).success).toBe(false)
    expect(workmateConfigSchema.safeParse({ taskFile: '/a', repos: ['/srv/a', ''] }).success).toBe(false)
  })

  it('未知键被拒绝（strict），避免配置漂移被静默吞掉', () => {
    const parsed = workmateConfigSchema.safeParse({ taskFile: '/tmp/a.json', unknownKey: 1 })
    expect(parsed.success).toBe(false)
  })

  it('taskFile 允许空默认值（parse({}) 不能抛），由 validateConfig 判为不可用', () => {
    expect(workmateConfigSchema.parse({}).taskFile).toBe('')
    expect(validateConfig({}).ok).toBe(false)
  })

  it('越界的数值被拒绝', () => {
    expect(workmateConfigSchema.safeParse({ taskFile: '/a', pollSeconds: 0 }).success).toBe(false)
    expect(workmateConfigSchema.safeParse({ taskFile: '/a', maxPerScan: -1 }).success).toBe(false)
  })
})

describe('kindIdOf', () => {
  it('没配 kind 时回落默认实例', () => {
    expect(kindIdOf(undefined)).toBe(DEFAULT_KIND)
    expect(kindIdOf({})).toBe(DEFAULT_KIND)
    expect(kindIdOf({ kind: '' })).toBe(DEFAULT_KIND)
    expect(kindIdOf({ kind: '   ' })).toBe(DEFAULT_KIND)
  })

  it('配置了就用配置（并去空白）', () => {
    expect(kindIdOf({ kind: 'workmate-b' })).toBe('workmate-b')
    expect(kindIdOf({ kind: ' workmate-b ' })).toBe('workmate-b')
    expect(DEFAULT_KIND).toBe('workmate')
  })
})

describe('validateConfig', () => {
  it('接受绝对路径', () => {
    const result = validateConfig({ taskFile: '/Users/x/.dsh/workmate/tasks.json' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.interactive).toBe(false)
      expect(result.config.kind).toBeUndefined()
      expect(result.config.repos).toEqual([])
    }
  })

  it('接受多实例配置（kind + repos，repos 也接受面板的逗号分隔字符串）', () => {
    const result = validateConfig({ taskFile: '/a/tasks.json', kind: 'workmate-b', repos: ['/srv/b'] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.kind).toBe('workmate-b')
      expect(result.config.repos).toEqual(['/srv/b'])
    }
    const fromText = validateConfig({ taskFile: '/a/tasks.json', repos: '/srv/a, /srv/b' })
    expect(fromText.ok).toBe(true)
    if (fromText.ok) expect(fromText.config.repos).toEqual(['/srv/a', '/srv/b'])
  })

  it('repos 里的相对路径判为不可用（无法与待办的绝对路径比较，宁可报错也不静默空转）', () => {
    const result = validateConfig({ taskFile: '/a/tasks.json', repos: ['srv/b'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/repos 必须是绝对路径/)
    // 面板文本框里的相对路径同样拦下。
    expect(validateConfig({ taskFile: '/a/tasks.json', repos: 'srv/b, /srv/c' }).ok).toBe(false)
  })

  it('拒绝相对路径并给出原因', () => {
    const result = validateConfig({ taskFile: 'workmate/tasks.json' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/绝对路径/)
  })

  it('缺 taskFile 时返回不可用而不是抛错', () => {
    const result = validateConfig({})
    expect(result.ok).toBe(false)
  })

  it('null/undefined 也走 fail 分支', () => {
    expect(validateConfig(null).ok).toBe(false)
    expect(validateConfig(undefined).ok).toBe(false)
  })
})

describe('kind 元数据', () => {
  it('六个必填字段齐全', () => {
    expect(kindMetadataShape.kind).toBe('workmate')
    expect(kindMetadataShape.title.zh).not.toBe('')
    expect(kindMetadataShape.title.en).not.toBe('')
    expect(kindMetadataShape.description.zh).not.toBe('')
    expect(kindMetadataShape.fields.length).toBeGreaterThan(0)
    expect(kindMetadataShape.health).toEqual(['workmate'])
  })

  it('字段声明覆盖所有可配置项（含多实例的 instance fact / repos）', () => {
    const keys = FIELDS.map((field) => field.key)
    for (const key of [
      'instance',
      'taskFile',
      'repos',
      'interactive',
      'pollSeconds',
      'maxPerScan',
      'maxRowsPerTask',
      'repoRoot',
      'openspecRoot',
    ]) {
      expect(keys).toContain(key)
    }
  })

  it('instance 是只读 fact、repos 是可编辑 text（Super-agent 的 rows 只支持记录数组）', () => {
    const instance = FIELDS.find((entry) => entry.key === 'instance')
    expect(instance?.type).toBe('fact')
    // rows 字段必须有 columns 且值是 Record<string,string>[]；repos 是 string[]，
    // 声明成 rows 会在设置页渲染错误（回归守卫）。
    const repos = FIELDS.find((entry) => entry.key === 'repos')
    expect(repos?.type).toBe('text')
    for (const key of ['instance', 'repos']) {
      const field = FIELDS.find((entry) => entry.key === key)
      expect(field?.label.zh).not.toBe('')
      expect(field?.label.en).not.toBe('')
      expect(field?.hint?.zh).not.toBe('')
      expect(field?.hint?.en).not.toBe('')
    }
    // 空数组语义是"不限制"，hint 必须说清楚，否则部署方会以为没配就什么都不投。
    expect(repos?.hint?.zh).toContain('不限制')
  })

  it('不声明任何"接受规则"或授权开关', () => {
    const keys = FIELDS.map((field) => field.key)
    expect(keys).not.toContain('acceptedRule')
    expect(keys).not.toContain('rules')
    expect(keys).not.toContain('allowed')
  })

  it('常量与规格一致', () => {
    expect(DEFAULT_KIND).toBe('workmate')
    expect(TITLE.en).toBe('WorkMate tasks')
    expect(DESCRIPTION.en.length).toBeGreaterThan(0)
  })
})

describe('policy 分片', () => {
  it('parse({}) 给出空的 allowed（默认拒绝，而不是默认放行）', () => {
    expect(policySchema.parse({})).toEqual({ allowed: [] })
  })

  it('接受 workmate:<createdBy> 形式的身份，并保留可选的显示名', () => {
    expect(policySchema.parse({ allowed: [{ id: 'workmate:panel', name: '面板' }] }).allowed).toEqual([
      { id: 'workmate:panel', name: '面板' },
    ])
  })

  it('拒绝未知键（strict），并且没有"接受规则"开关', () => {
    expect(() => policySchema.parse({ acceptedRule: 'anything' })).toThrow()
    expect(POLICY_FIELDS.map((field) => field.key)).toEqual(['allowed'])
    expect(POLICY_FIELDS.map((field) => field.key)).not.toContain('rules')
  })

  it('准入表只有一行，且只放行"未列入但 @ 了来源"的格子', () => {
    const rows = policyRows({})
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
  })

  it('explicit 说明与设计一致（名单内 + 明确提及）', () => {
    expect(POLICY_EXPLICIT.zh).toContain('明确请求')
    expect(POLICY_EXPLICIT.en.length).toBeGreaterThan(0)
  })
})

describe('titleOf（按实例区分来源页标题）', () => {
  it('默认实例沿用原标题，其余实例带 id', () => {
    expect(titleOf(DEFAULT_KIND)).toEqual({ zh: TITLE.zh, en: TITLE.en })
    expect(titleOf('workmate-b').zh).toBe(`${TITLE.zh}（workmate-b）`)
    expect(titleOf('workmate-b').en).toBe(`${TITLE.en} (workmate-b)`)
  })
})

describe('factsOf', () => {
  it('给出可读事实', () => {
    const facts = factsOf({
      instance: 'workmate',
      taskFile: '/a/b.json',
      pending: 3,
      waitingOnDependency: 1,
      lastScanAt: '2026-11-02T00:00:00.000Z',
    })
    expect(facts['instance']).toBe('workmate')
    expect(facts['taskFile']).toBe('/a/b.json')
    expect(facts['lastScan']).toBe('2026-11-02T00:00:00.000Z')
    expect(JSON.stringify(facts['pending'])).toContain('3')
  })

  it('未扫描时给中文占位', () => {
    const facts = factsOf({ instance: 'workmate-b', taskFile: '/a', pending: 0, waitingOnDependency: 0 })
    expect(facts['instance']).toBe('workmate-b')
    expect(JSON.stringify(facts['lastScan'])).toContain('尚未扫描')
  })
})
