import { describe, expect, it } from 'vitest'
import { contractFor, rolesFor, ROLE_CONTRACTS, TEAM_TEMPLATE_CONTRACTS } from './roster.ts'
import { TEAM_ROLES, TEAM_TEMPLATES } from './types.ts'

describe('team roster', () => {
  it('has a contract for every role', () => {
    expect(Object.keys(ROLE_CONTRACTS).sort()).toEqual([...TEAM_ROLES].sort())
    for (const role of TEAM_ROLES) {
      const contract = contractFor(role)
      expect(contract.role).toBe(role)
      expect(contract.responsibility.length).toBeGreaterThan(0)
    }
  })

  it('keeps evaluators and reviewer read-only, implementers writable', () => {
    expect(contractFor('requirement-evaluator').permission).toBe('read-only')
    expect(contractFor('solution-evaluator').permission).toBe('read-only')
    expect(contractFor('reviewer').permission).toBe('read-only')
    expect(contractFor('frontend-dev').permission).toBe('workspace-write')
    expect(contractFor('backend-dev').permission).toBe('workspace-write')
    expect(contractFor('integration-tester').permission).toBe('workspace-write')
    expect(contractFor('coordinator').permission).toBe('workspace-write')
    expect(contractFor('reviewer').canModifyCode).toBe(false)
  })

  it('defines a contract for every template', () => {
    for (const template of TEAM_TEMPLATES) {
      const contract = TEAM_TEMPLATE_CONTRACTS[template]
      expect(contract.template).toBe(template)
      expect(contract.roles).toContain('coordinator')
      expect(contract.roles).toContain('reviewer')
    }
  })

  it('assembles the full template and trims research roles', () => {
    expect(rolesFor('requirement-full')).toEqual([...TEAM_ROLES])
    expect(rolesFor('research')).not.toContain('frontend-dev')
    expect(rolesFor('research')).not.toContain('backend-dev')
    expect(rolesFor('bug-fix')).toContain('integration-tester')
  })
})
