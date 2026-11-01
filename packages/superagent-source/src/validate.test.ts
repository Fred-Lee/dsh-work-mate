import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isValidMessageId,
  isValidProposalId,
  messageIdIssue,
  proposalIdIssue,
  resolveChangeDir,
} from './validate.ts'

describe('isValidProposalId', () => {
  it('接受 openspec 风格 id', () => {
    expect(isValidProposalId('adopt-superagent-openspec-source')).toBe(true)
    expect(isValidProposalId('a1')).toBe(true)
  })

  it('拒绝路径穿越与非法字符', () => {
    for (const bad of ['../../etc', '..', '.', 'a/b', 'A-B', '', ' has space', '../x']) {
      expect(isValidProposalId(bad)).toBe(false)
    }
  })
})

describe('isValidMessageId', () => {
  it('接受 32 位十六进制', () => {
    expect(isValidMessageId('a'.repeat(32))).toBe(true)
    expect(isValidMessageId('0123456789abcdef0123456789abcdef')).toBe(true)
  })

  it('拒绝长度不符或大写的 id', () => {
    expect(isValidMessageId('a'.repeat(31))).toBe(false)
    expect(isValidMessageId('A'.repeat(32))).toBe(false)
    expect(isValidMessageId('g'.repeat(32))).toBe(false)
    expect(isValidMessageId('')).toBe(false)
  })
})

describe('resolveChangeDir', () => {
  const root = '/repo/openspec/changes'

  it('正常拼接', () => {
    expect(resolveChangeDir(root, 'add-thing')).toBe(join(root, 'add-thing'))
  })

  it('路径穿越被拒', () => {
    expect(resolveChangeDir(root, '../../../etc')).toBeUndefined()
    expect(resolveChangeDir(root, '..')).toBeUndefined()
  })

  it('绝对路径被拒', () => {
    expect(resolveChangeDir(root, '/etc/passwd')).toBeUndefined()
  })

  it('多级路径被拒（只接受 root 的直接子目录）', () => {
    expect(resolveChangeDir(root, 'a/b')).toBeUndefined()
  })

  it('非法 id 被拒', () => {
    expect(resolveChangeDir(root, 'A-Upper')).toBeUndefined()
    expect(resolveChangeDir(root, '')).toBeUndefined()
  })
})

describe('issue 描述', () => {
  it('带字段名与原因，便于写进健康条目', () => {
    expect(proposalIdIssue('../x').field).toBe('proposalId')
    expect(proposalIdIssue('../x').reason).toMatch(/不合法/)
    expect(messageIdIssue('zz').reason).toMatch(/32 位/)
  })
})
