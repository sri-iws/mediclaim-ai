import process from 'node:process'
import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, deleteDemoUsers, updateClaimStatus } from './db.js'

const originalNodeEnv = process.env.NODE_ENV
const originalJwtSecret = process.env.JWT_SECRET
const originalAiServiceUrl = process.env.AI_SERVICE_URL
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret'
process.env.AI_SERVICE_URL = 'http://127.0.0.1:8000'

const { app } = await import('./index.js')
let server
let baseUrl

async function api(pathname, { token, ...options } = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { ...headers, ...options.headers },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  })
  return { response, body: await response.json() }
}

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  closeDatabase()
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
  if (originalAiServiceUrl === undefined) delete process.env.AI_SERVICE_URL
  else process.env.AI_SERVICE_URL = originalAiServiceUrl
})

describe('MediClaim backend services', () => {
  it('provides health status and requires authentication for protected retrievals', async () => {
    const health = await api('/api/health')
    const protectedResponse = await api('/api/claims')

    expect(health.body.status).toBe('ok')
    expect(protectedResponse.response.status).toBe(401)
  })

  it('authenticates seeded users and prevents public role escalation', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@mediclaim.ai', password: 'admin123' },
    })
    const registered = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Test Person', email: 'test@example.test', password: 'safe-password', role: 'admin' },
    })
    const duplicateRegistration = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Test Person', email: 'test@example.test', password: 'safe-password' },
    })
    const registeredUserLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'test@example.test', password: 'safe-password' },
    })
    const directory = await api('/api/users', { token: login.body.token })
    const regularUserDirectory = await api('/api/users', { token: registered.body.token })

    expect(login.response.status).toBe(200)
    expect(login.body.user.role).toBe('admin')
    expect(login.body.user.passwordHash).toBeUndefined()
    expect(registered.response.status).toBe(201)
    expect(registered.body.user.role).toBe('reviewer')
    expect(registeredUserLogin.response.status).toBe(200)
    expect(registeredUserLogin.body.user.email).toBe('test@example.test')
    expect(duplicateRegistration.response.status).toBe(409)
    expect(directory.body.users).toHaveLength(4)
    expect(regularUserDirectory.response.status).toBe(403)
  })

  it('retrieves policy lists and individual policy records', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const policyList = await api('/api/policies?q=wellness', { token: login.body.token })
    const policy = await api('/api/policies/POL-8854', { token: login.body.token })

    expect(policyList.body.policies).toHaveLength(1)
    expect(policyList.body.policies[0].name).toBe('Wellness Plus')
    expect(policy.body.policy.policyNumber).toBe('POL-8854')
  })

  it('authenticates document analysis and forwards uploads with claim fields to the AI service', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const unauthenticated = await api('/api/documents/analyze?filename=invoice.pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('private claim document'),
    })
    const originalFetch = globalThis.fetch
    let forwardedFile
    let forwardedClaimant
    globalThis.fetch = async (input, options) => {
      if (String(input) === 'http://127.0.0.1:8000/api/analyze') {
        const form = options.body
        forwardedFile = { name: form.get('file').name, text: await form.get('file').text() }
        forwardedClaimant = form.get('claimant')
        return new Response(JSON.stringify({ extracted_fields: { claimant: 'Sample Claimant' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input, options)
    }

    try {
      const response = await originalFetch(`${baseUrl}/api/documents/analyze?${new URLSearchParams({
        filename: 'invoice.pdf',
        fields: JSON.stringify({ claimant: 'Sample Claimant' }),
      })}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${login.body.token}`,
          'Content-Type': 'application/octet-stream',
          'X-Upload-Content-Type': 'application/pdf',
        },
        body: Buffer.from('private claim document'),
      })
      const body = await response.json()

      expect(unauthenticated.response.status).toBe(401)
      expect(response.status).toBe(200)
      expect(body.extracted_fields.claimant).toBe('Sample Claimant')
      expect(forwardedFile).toEqual({ name: 'invoice.pdf', text: 'private claim document' })
      expect(forwardedClaimant).toBe('Sample Claimant')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('requires authentication and proxies CPT procedure results to the AI service', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const unauthorized = await api('/api/procedure-results', {
      method: 'POST',
      body: { codes: '99213' },
    })
    const originalFetch = globalThis.fetch
    let forwardedCodes
    globalThis.fetch = async (input, options) => {
      if (String(input) === 'http://127.0.0.1:8000/api/procedure-results') {
        forwardedCodes = JSON.parse(options.body).codes
        return new Response(JSON.stringify({ procedures: [{ code: '99213', description: 'Office visit' }] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input, options)
    }

    try {
      const prediction = await api('/api/procedure-results', {
        method: 'POST',
        token: login.body.token,
        body: { codes: '  99213, 99214  ' },
      })
      const missingInput = await api('/api/procedure-results', {
        method: 'POST',
        token: login.body.token,
        body: { codes: ' ' },
      })

      expect(unauthorized.response.status).toBe(401)
      expect(prediction.response.status).toBe(200)
      expect(prediction.body.procedures[0].description).toBe('Office visit')
      expect(forwardedCodes).toBe('99213, 99214')
      expect(missingInput.response.status).toBe(400)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('creates and retrieves claims and updates dashboard metrics', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const token = login.body.token
    const created = await api('/api/claims', {
      method: 'POST',
      token,
      body: {
        claimant: 'Sample Claimant',
        provider: 'Sample Clinic',
        amount: 1250,
        diagnosis: 'Diagnostic consultation 99213',
        treatmentItems: [{ code: '99213', name: 'Office visit', billedPrice: 125 }],
        documents: ['invoice.pdf'],
      },
    })
    const allClaims = await api('/api/claims', { token })
    const filteredClaims = await api('/api/claims?status=submitted&q=Sample', { token })
    const singleClaim = await api(`/api/claims/${created.body.claim.id}`, { token })
    const review = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token,
      body: { action: 'accept', comment: 'Evidence checked and coverage confirmed.' },
    })
    const savedClaim = await api(`/api/claims/${created.body.claim.id}`, { token })
    const metrics = await api('/api/dashboard/metrics', { token })

    expect(created.response.status).toBe(201)
    expect(allClaims.body.claims).toHaveLength(1)
    expect(filteredClaims.body.claims[0].id).toBe(created.body.claim.id)
    expect(singleClaim.body.claim.documents).toEqual(['invoice.pdf'])
    expect(singleClaim.body.claim.diagnosis).toBe('Diagnostic consultation (99213)')
    expect(singleClaim.body.claim.treatmentItems).toEqual([{ code: '99213', name: 'Office visit', billedPrice: 125 }])
    expect(singleClaim.body.claim.policyNumber).toBe('')
    expect(singleClaim.body.claim.auditTrail[0].type).toBe('claim_submitted')
    expect(review.body.claim.status).toBe('accepted')
    expect(review.body.claim.reviewDecision).toMatchObject({ action: 'accept', comment: 'Evidence checked and coverage confirmed.' })
    expect(savedClaim.body.claim.auditTrail).toHaveLength(2)
    expect(metrics.body.metrics).toMatchObject({ totalClaims: 1, inReview: 0, evidenceFiles: 1 })
  })

  it('rejects claims with an unavailable provider or policy by default', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const token = login.body.token
    const missingProvider = await api('/api/claims', {
      method: 'POST',
      token,
      body: { claimant: 'Missing Provider', policyNumber: 'POL-2048', provider: 'N/A', diagnosis: 'Consultation' },
    })
    const missingPolicy = await api('/api/claims', {
      method: 'POST',
      token,
      body: { claimant: 'Missing Policy', policyNumber: ' n/a ', provider: 'Sample Clinic', diagnosis: 'Consultation' },
    })

    expect(missingProvider.body.claim.status).toBe('rejected')
    expect(missingProvider.body.claim.auditTrail[0].reason).toBe('Missing fields: Provider')
    expect(missingPolicy.body.claim.status).toBe('rejected')
    expect(missingPolicy.body.claim.auditTrail[0].reason).toBe('Missing fields: Policy')
  })

  it('rejects malformed billed treatment line items', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const invalid = await api('/api/claims', {
      method: 'POST',
      token: login.body.token,
      body: {
        claimant: 'Invalid Line Item',
        provider: 'Sample Clinic',
        diagnosis: 'Consultation',
        treatmentItems: [{ code: '9921X', name: 'Office visit', billedPrice: 125 }],
      },
    })

    expect(invalid.response.status).toBe(400)
    expect(invalid.body.message).toContain('five-digit CPT code')
  })

  it('rejects invalid review actions and blocks auditors from making decisions', async () => {
    const reviewer = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const auditor = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'auditor@mediclaim.ai', password: 'auditor123' },
    })
    const created = await api('/api/claims', {
      method: 'POST',
      token: reviewer.body.token,
      body: { claimant: 'Review Test', policyNumber: 'POL-1108', provider: 'Test Clinic', amount: 100, diagnosis: 'Checkup' },
    })
    const invalidAction = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: reviewer.body.token,
      body: { action: 'maybe' },
    })
    const forbiddenDecision = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: auditor.body.token,
      body: { action: 'reject' },
    })

    expect(invalidAction.response.status).toBe(400)
    expect(forbiddenDecision.response.status).toBe(403)
  })

  it('escalates claims and records a later rejection in the audit history', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const created = await api('/api/claims', {
      method: 'POST',
      token: login.body.token,
      body: { claimant: 'Decision Test', policyNumber: 'POL-1108', provider: 'Test Clinic', amount: 100, diagnosis: 'Checkup' },
    })
    const reconciled = await api(`/api/claims/${created.body.claim.id}/reconciliation`, {
      method: 'PATCH',
      token: login.body.token,
      body: { reconciled: true, comment: 'Invoice and treatment evidence match.' },
    })
    const escalated = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: login.body.token,
      body: { action: 'escalate', comment: 'Needs specialist review.' },
    })
    const rejected = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: login.body.token,
      body: { action: 'reject', comment: 'Coverage criteria were not met.' },
    })
    const metricsBeforeReopen = await api('/api/dashboard/metrics', { token: login.body.token })
    const reopened = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: login.body.token,
      body: { action: 'reopen', comment: 'Additional documentation received.' },
    })
    const metricsAfterReopen = await api('/api/dashboard/metrics', { token: login.body.token })

    expect(reconciled.body.claim.reconciliation).toMatchObject({ reconciled: true, comment: 'Invoice and treatment evidence match.' })
    expect(reconciled.body.claim.auditTrail.at(-1).type).toBe('evidence_reconciled')
    expect(escalated.body.claim.status).toBe('escalated')
    expect(escalated.body.claim.auditTrail.at(-1)).toMatchObject({ action: 'escalate', comment: 'Needs specialist review.' })
    expect(rejected.body.claim.status).toBe('rejected')
    expect(rejected.body.claim.reviewDecision).toMatchObject({ action: 'reject', comment: 'Coverage criteria were not met.' })
    expect(rejected.body.claim.auditTrail.map((event) => event.action)).toEqual([undefined, undefined, 'escalate', 'reject'])
    expect(reopened.body.claim.status).toBe('reopened')
    expect(reopened.body.claim.reviewDecision).toBeUndefined()
    expect(reopened.body.claim.auditTrail.at(-1)).toMatchObject({ type: 'claim_reopened', fromStatus: 'rejected', toStatus: 'reopened', comment: 'Additional documentation received.' })
    expect(metricsAfterReopen.body.metrics.byStatus.reopened).toBe(1)
    expect(metricsAfterReopen.body.metrics.inReview).toBe(metricsBeforeReopen.body.metrics.inReview + 1)
  })

  it('validates reconciliation requests and only reopens final claims', async () => {
    const reviewer = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const created = await api('/api/claims', {
      method: 'POST',
      token: reviewer.body.token,
      body: { claimant: 'Workflow Test', policyNumber: '', provider: 'Test Clinic', amount: 25, diagnosis: 'Checkup' },
    })
    const invalidReconciliation = await api(`/api/claims/${created.body.claim.id}/reconciliation`, {
      method: 'PATCH',
      token: reviewer.body.token,
      body: { reconciled: 'yes' },
    })
    const reopenSubmitted = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: reviewer.body.token,
      body: { action: 'reopen' },
    })
    await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: reviewer.body.token,
      body: { action: 'accept' },
    })
    await updateClaimStatus(created.body.claim.id, 'approved')
    const reopenApproved = await api(`/api/claims/${created.body.claim.id}/review`, {
      method: 'PATCH',
      token: reviewer.body.token,
      body: { action: 'reopened', comment: 'Reopen a legacy approved record.' },
    })

    expect(invalidReconciliation.response.status).toBe(400)
    expect(reopenSubmitted.response.status).toBe(409)
    expect(reopenApproved.response.status).toBe(200)
    expect(reopenApproved.body.claim.status).toBe('reopened')
    expect(reopenApproved.body.claim.auditTrail.at(-1).fromStatus).toBe('approved')
  })

  it('deletes a single claim and blocks unauthenticated deletion', async () => {
    const reviewer = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const created = await api('/api/claims', {
      method: 'POST',
      token: reviewer.body.token,
      body: { claimant: 'Delete Test', provider: 'Test Clinic', amount: 50, diagnosis: 'Checkup' },
    })
    const unauthorized = await api(`/api/claims/${created.body.claim.id}`, { method: 'DELETE' })
    const deleted = await api(`/api/claims/${created.body.claim.id}`, { method: 'DELETE', token: reviewer.body.token })
    const missing = await api(`/api/claims/${created.body.claim.id}`, { token: reviewer.body.token })
    const deleteAgain = await api(`/api/claims/${created.body.claim.id}`, { method: 'DELETE', token: reviewer.body.token })

    expect(unauthorized.response.status).toBe(401)
    expect(deleted.response.status).toBe(200)
    expect(missing.response.status).toBe(404)
    expect(deleteAgain.response.status).toBe(404)
  })

  it('restricts clearing all claims to admins and empties the claims table', async () => {
    const reviewer = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'reviewer@mediclaim.ai', password: 'reviewer123' },
    })
    const admin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@mediclaim.ai', password: 'admin123' },
    })
    await api('/api/claims', {
      method: 'POST',
      token: reviewer.body.token,
      body: { claimant: 'Bulk Delete Test', provider: 'Test Clinic', amount: 10, diagnosis: 'Checkup' },
    })
    const forbidden = await api('/api/claims', { method: 'DELETE', token: reviewer.body.token })
    const cleared = await api('/api/claims', { method: 'DELETE', token: admin.body.token })
    const remaining = await api('/api/claims', { token: admin.body.token })

    expect(forbidden.response.status).toBe(403)
    expect(cleared.response.status).toBe(200)
    expect(remaining.body.claims).toHaveLength(0)
  })

  it('removes built-in demo accounts during production hardening', async () => {
    await deleteDemoUsers()
    const demoLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@mediclaim.ai', password: 'admin123' },
    })

    expect(demoLogin.response.status).toBe(401)
  })
})
