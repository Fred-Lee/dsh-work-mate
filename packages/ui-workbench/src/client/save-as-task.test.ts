import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORKBENCH_BASE,
  buildIntakeBody,
  intakeUrl,
  parseIntakeResponse,
  saveAsTask,
  validateIntake,
} from './save-as-task'

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

describe('intakeUrl', () => {
  it('targets the existing host route under the default mount', () => {
    expect(intakeUrl()).toBe(`${DEFAULT_WORKBENCH_BASE}/api/task-from-conversation`)
  })

  it('tolerates a trailing slash on a custom mount', () => {
    expect(intakeUrl('/custom-workbench/')).toBe('/custom-workbench/api/task-from-conversation')
  })
})

describe('buildIntakeBody', () => {
  it('sends only title + sessionId, so the host resolves the repo from cwd', () => {
    expect(buildIntakeBody({ title: '  实现检索  ', sessionId: 's1' })).toEqual({
      title: '实现检索',
      sessionId: 's1',
    })
  })
})

describe('validateIntake', () => {
  it('rejects a blank title', () => {
    expect(validateIntake({ title: '   ', sessionId: 's1' })).toContain('标题')
  })

  it('rejects a missing session context', () => {
    expect(validateIntake({ title: 'x', sessionId: '' })).toContain('会话')
  })

  it('accepts a complete input', () => {
    expect(validateIntake({ title: 'x', sessionId: 's1' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

describe('parseIntakeResponse', () => {
  it('reads the card id and summary metadata off a success', () => {
    const outcome = parseIntakeResponse(200, {
      ok: true,
      id: 'wi_abc',
      item: { id: 'wi_abc', stage: 'requirements', stageLabel: '需求分析' },
      summary: { text: '摘要正文', generatedBy: 'model' },
      context: { messages: 12, source: 'sessions' },
      warnings: ['摘要回写失败'],
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.id).toBe('wi_abc')
    expect(outcome.stageLabel).toBe('需求分析')
    expect(outcome.summaryText).toBe('摘要正文')
    expect(outcome.summarySource).toBe('model')
    expect(outcome.contextMessages).toBe(12)
    expect(outcome.warnings).toEqual(['摘要回写失败'])
  })

  it('accepts a card id that only the item carries', () => {
    expect(parseIntakeResponse(200, { ok: true, item: { id: 'wi_x' } }).id).toBe('wi_x')
  })

  // The host's refusals are already specific ("invalid repo: 需要 repo 或
  // projectGroup…"). Replacing them with a generic message would throw away the
  // one piece of information that tells the user what to do.
  it('surfaces a 4xx refusal verbatim', () => {
    const outcome = parseIntakeResponse(400, {
      error: 'invalid repo: 需要 repo 或 projectGroup(或提供能解析出 cwd 的 sessionId)',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('invalid repo')
    expect(outcome.reason).toContain('sessionId')
  })

  it('treats a 2xx body that reports failure as a refusal', () => {
    const outcome = parseIntakeResponse(200, { ok: false, reason: 'board 拒绝' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('board 拒绝')
  })

  // A 2xx with no id means no card exists. Reporting success would send the
  // user to a card that was never created.
  it('refuses to report success without a card id', () => {
    const outcome = parseIntakeResponse(200, { ok: true })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('缺少卡片 id')
  })

  it('drops non-string warnings rather than rendering junk', () => {
    const outcome = parseIntakeResponse(200, { ok: true, id: 'wi_1', warnings: ['ok', 7, null] })
    expect(outcome.warnings).toEqual(['ok'])
  })

  it('omits warnings entirely when there are none', () => {
    expect(parseIntakeResponse(200, { ok: true, id: 'wi_1' }).warnings).toBeUndefined()
  })

  it('falls back to a status-bearing message when the body has no error text', () => {
    expect(parseIntakeResponse(500, null).reason).toContain('500')
  })
})

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('saveAsTask', () => {
  it('posts { title, sessionId } to the host route', async () => {
    const fetchImpl = fakeFetch(200, { ok: true, id: 'wi_1', item: { stageLabel: '需求分析' } })
    const outcome = await saveAsTask(
      { title: ' 实现检索 ', sessionId: 's1' },
      { fetchImpl, base: '/helmsman-workbench' },
    )

    expect(outcome.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toBe('/helmsman-workbench/api/task-from-conversation')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ title: '实现检索', sessionId: 's1' })
  })

  it('resolves a refusal instead of throwing, so the caller can show it', async () => {
    const outcome = await saveAsTask(
      { title: 'x', sessionId: 's1' },
      { fetchImpl: fakeFetch(400, { error: 'invalid repo' }) },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('invalid repo')
  })

  it('never calls the host for an input it already knows is invalid', async () => {
    const fetchImpl = fakeFetch(200, { ok: true, id: 'wi_1' })
    const outcome = await saveAsTask({ title: '  ', sessionId: 's1' }, { fetchImpl })
    expect(outcome.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports an unreachable host as a reason, not an exception', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Failed to fetch')
    }) as unknown as typeof fetch
    const outcome = await saveAsTask({ title: 'x', sessionId: 's1' }, { fetchImpl })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('Failed to fetch')
  })

  it('treats a non-JSON body as a status-bearing refusal', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    })) as unknown as typeof fetch
    const outcome = await saveAsTask({ title: 'x', sessionId: 's1' }, { fetchImpl })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('502')
  })
})
