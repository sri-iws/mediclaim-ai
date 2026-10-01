import { describe, expect, it } from 'vitest'
import { hasAccess, loginUser, registerUser } from './auth'
import { createClaim } from './claims'

describe('MediClaim user authentication', () => {
  it('registers a new user with a selected role', () => {
    const result = registerUser({
      name: 'Sam Verma',
      email: 'sam@mediclaim.ai',
      password: 'SecurePass123',
      role: 'reviewer',
    })

    expect(result.success).toBe(true)
    expect(result.user.role).toBe('reviewer')
  })

  it('prevents duplicate email registration', () => {
    const result = registerUser({
      name: 'Admin User',
      email: 'admin@mediclaim.ai',
      password: 'admin123',
      role: 'admin',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('already registered')
  })

  it('logs in an existing user and verifies role access', () => {
    const loginResult = loginUser('admin@mediclaim.ai', 'admin123')

    expect(loginResult.success).toBe(true)
    expect(loginResult.user.role).toBe('admin')
    expect(hasAccess('admin', 'claims_review')).toBe(true)
    expect(hasAccess('auditor', 'policy_management')).toBe(false)
  })

  it('logs in the seeded reviewer account successfully', () => {
    const loginResult = loginUser('reviewer@mediclaim.ai', 'reviewer123')

    expect(loginResult.success).toBe(true)
    expect(loginResult.user.role).toBe('reviewer')
    expect(hasAccess('reviewer', 'claims_review')).toBe(true)
  })

  it('creates a claim with document uploads and status tracking', () => {
    const created = createClaim({
      claimant: 'Priya Sharma',
      policyNumber: 'POL-2048',
      provider: 'City Care Hospital',
      amount: 4800,
      diagnosis: 'Orthopedic procedure',
      documents: ['invoice.pdf', 'discharge-summary.pdf'],
      documentAnalysis: {
        diagnosisCode: 'M25.511',
        diagnosisCodes: ['M25.511', 'M25.512'],
        cptCodes: ['20610'],
      },
    })

    expect(created.success).toBe(true)
    expect(created.claim.status).toBe('submitted')
    expect(created.claim.documents).toHaveLength(2)
    expect(created.claim.documentAnalysis.extracted.diagnosisCodes).toEqual(['M25.511', 'M25.512'])
    expect(created.claim.documentAnalysis.extracted.cptCodes).toEqual(['20610'])
  })

  it('wraps bare five-digit procedure codes in the created diagnosis', () => {
    const created = createClaim({
      claimant: 'Nina Patel',
      policyNumber: 'POL-2048',
      provider: 'City Care Hospital',
      diagnosis: 'Office visit 99213 and follow-up (99214), reference 20261001',
    })

    expect(created.claim.diagnosis).toBe('Office visit (99213) and follow-up (99214), reference 20261001')
  })
})
