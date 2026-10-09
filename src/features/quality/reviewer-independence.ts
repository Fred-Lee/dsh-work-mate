/**
 * Reviewer-independence verdict (change `harden-archive-gates`, design D2).
 *
 * The review.md header may name the reviewer (`<!-- reviewer: auditor@1.2 -->`).
 * Until now that name was only used for the shadow flag and for display, so an
 * author could cite themselves as the independent checker and the archive gate
 * would not notice. This module is the honest half of the fix: it compares a
 * self-reported name against an identity set taken from git, and it reports
 * `undetermined` — never a silent pass, never a false accusation — when either
 * side is missing.
 *
 * Pure: no filesystem, no git. The archive layer collects the identities.
 */

export interface Identity {
  name: string
  email?: string
}

export type IndependenceVerdict = 'independent' | 'same-as-author' | 'missing' | 'undetermined'

export interface IndependenceInput {
  /** The `<!-- reviewer: X -->` value; undefined when the header carried no name. */
  reviewer?: string
  /** True for `<!-- reviewer: X shadow -->`: a reviewer still earning trust. */
  shadow: boolean
  /** Identities of the proposal's executors (commit authors carrying the marker). */
  executors: readonly Identity[]
}

export interface IndependenceResult {
  verdict: IndependenceVerdict
  /** Who the verdict matched, when it matched somebody. */
  matched?: Identity
  /** One line explaining the verdict for the archive step. */
  note: string
}

/** Does a self-reported reviewer name refer to this identity? */
function matches(reviewer: string, identity: Identity): boolean {
  const needle = reviewer.trim().toLowerCase()
  if (needle === '') return false
  const name = identity.name.trim().toLowerCase()
  if (name !== '' && needle === name) return true
  if (identity.email !== undefined) {
    const email = identity.email.trim().toLowerCase()
    if (email !== '' && needle === email) return true
    // `auditor@1.2` style handles: compare the local part before `@`.
    const local = email.split('@')[0] ?? ''
    if (local !== '' && needle === local) return true
    if (name !== '' && name.includes(needle)) return true
  }
  return name !== '' && name.includes(needle)
}

/**
 * Decide whether a self-reported reviewer is independent of the executors.
 * @param input - reviewer name, shadow flag and the executor identity set.
 * @returns the verdict plus a one-line note; `undetermined` when git facts are missing.
 */
export function judgeReviewerIndependence(input: IndependenceInput): IndependenceResult {
  const reviewer = input.reviewer?.trim() ?? ''
  if (input.executors.length === 0) {
    return {
      verdict: 'undetermined',
      note: reviewer === ''
        ? '无执行者身份事实且审查报告未署名 —— 无法判定独立性'
        : `审查者 ${reviewer}：无执行者身份事实（git 不可用或无标记提交）—— 无法判定独立性`,
    }
  }
  if (reviewer === '') {
    return {
      verdict: 'missing',
      note: input.shadow
        ? '影子审查报告未署名 —— shadow 档不阻断'
        : `审查报告未署名（executors: ${input.executors.map((identity) => identity.name).join(', ')}）`,
    }
  }
  const hit = input.executors.find((identity) => matches(reviewer, identity))
  if (hit !== undefined) {
    return {
      verdict: 'same-as-author',
      matched: hit,
      note: `审查者 ${reviewer} 与执行者 ${hit.name}${hit.email !== undefined ? ` <${hit.email}>` : ''} 是同一身份 —— 不是独立审查`,
    }
  }
  return {
    verdict: 'independent',
    note: `审查者 ${reviewer} 不在执行者身份集合内（${input.executors.length} 个执行者）`,
  }
}
