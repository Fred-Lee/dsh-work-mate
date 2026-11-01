/**
 * 输入校验（change `adopt-superagent-openspec-source`, task 23）。
 *
 * 两处校验都防"本地文件被外部写入后把坏数据带进模型上下文"：
 *   - `proposalId` 会被拼进 `<repoRoot>/<openspecRoot>/changes/<id>/`，必须挡路径穿越；
 *   - `messageId` 是幂等键，伪造一行就能抑制真实回写。
 *
 * 这不是身份认证：能写任务文件的本地用户本来就拥有这台机器。它只是让"越界输入"
 * 显式失败，而不是静默读错文件或静默吞掉回写。
 */
import { resolve, sep } from 'node:path'

/** Super-agent 的确定性消息 ID：sha256 前 32 位（`src/core/ids.ts:3-5`）。 */
const MESSAGE_ID = /^[a-f0-9]{32}$/

/** OpenSpec change id 的白名单（与 openspec 自己的命名一致）。 */
const PROPOSAL_ID = /^[a-z0-9][a-z0-9-]*$/

export function isValidProposalId(value: string): boolean {
  return PROPOSAL_ID.test(value)
}

export function isValidMessageId(value: string): boolean {
  return MESSAGE_ID.test(value)
}

/**
 * 把 `proposalId` 解析成 change 目录的绝对路径；不合法或越界时返回 `undefined`。
 * `root` 是 `<repoRoot>/<openspecRoot>/changes`。
 */
export function resolveChangeDir(root: string, proposalId: string): string | undefined {
  if (!isValidProposalId(proposalId)) return undefined
  const base = resolve(root)
  const candidate = resolve(base, proposalId)
  // 拼接结果必须仍在 root 之下，并且是 root 的直接子目录。
  if (!candidate.startsWith(base + sep)) return undefined
  const relative = candidate.slice(base.length + sep.length)
  if (relative.includes(sep)) return undefined
  return candidate
}

/** 校验失败的原因，供健康条目使用。 */
export interface ValidationIssue {
  field: 'proposalId' | 'messageId'
  value: string
  reason: string
}

export const proposalIdIssue = (value: string): ValidationIssue => ({
  field: 'proposalId',
  value,
  reason: 'proposalId 不合法（只允许小写字母、数字与连字符，且不能为空）',
})

export const messageIdIssue = (value: string): ValidationIssue => ({
  field: 'messageId',
  value,
  reason: 'messageId 不是 32 位小写十六进制（与 Super-agent 的确定性 ID 不符）',
})
