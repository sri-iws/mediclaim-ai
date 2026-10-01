import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { promisify } from 'node:util'
import 'dotenv/config'
import express from 'express'
import {
  deleteAllClaims,
  deleteClaim,
  deleteDemoUsers,
  findClaim,
  findPolicy,
  findUserByEmail,
  findUserById,
  getDashboardMetrics,
  initializeDatabase,
  insertClaim,
  insertPolicy,
  insertUser,
  listClaims,
  listPolicies,
  listUsers,
  reopenClaim,
  saveClaimReconciliation,
  saveClaimReview,
} from './db.js'

const scrypt = promisify(scryptCallback)
const tokenSecret = process.env.JWT_SECRET || 'local-development-secret-change-before-deployment'
const tokenLifetimeSeconds = 60 * 60 * 8
const aiServiceUrl = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const BARE_FIVE_DIGIT_CODE = /(?<![\d()])(\d{5})(?![\d()])/g

function normalizeFiveDigitCodes(value) {
  return String(value || '').replace(BARE_FIVE_DIGIT_CODE, '($1)')
}

function publicUser(user) {
  const safeUser = { ...user }
  delete safeUser.passwordHash
  return safeUser
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derivedKey = await scrypt(password, salt, 64)
  return `${salt}:${derivedKey.toString('hex')}`
}

async function verifyPassword(password, passwordHash) {
  const [salt, expectedHex] = String(passwordHash || '').split(':')
  if (!salt || !expectedHex) return false
  const actual = await scrypt(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function signToken(user) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + tokenLifetimeSeconds,
  })).toString('base64url')
  const unsignedToken = `${header}.${payload}`
  const signature = createHmac('sha256', tokenSecret).update(unsignedToken).digest('base64url')
  return `${unsignedToken}.${signature}`
}

function readToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const unsignedToken = `${parts[0]}.${parts[1]}`
  const expectedSignature = createHmac('sha256', tokenSecret).update(unsignedToken).digest()
  const actualSignature = Buffer.from(parts[2], 'base64url')
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    if (!payload.sub || !payload.role || payload.exp <= Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

async function requireAuthentication(request, response, next) {
  const authorization = request.headers.authorization || ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  const tokenPayload = match && readToken(match[1])
  if (!tokenPayload) return response.status(401).json({ message: 'Please sign in to access this service.' })

  const user = await findUserById(tokenPayload.sub)
  if (!user) return response.status(401).json({ message: 'This account is no longer available.' })
  request.user = publicUser(user)
  next()
}

function requireRole(...roles) {
  return (request, response, next) => {
    if (!roles.includes(request.user.role)) {
      return response.status(403).json({ message: 'Your account does not have access to this service.' })
    }
    next()
  }
}

async function seedDatabase() {
  if (process.env.NODE_ENV === 'production') {
    await deleteDemoUsers()
  } else {
    const demoUsers = [
      { id: 'user-admin-1', name: 'Admin User', email: 'admin@mediclaim.ai', password: 'admin123', role: 'admin' },
      { id: 'user-auditor-1', name: 'Aisha Khan', email: 'auditor@mediclaim.ai', password: 'auditor123', role: 'auditor' },
      { id: 'user-reviewer-1', name: 'Priya Nair', email: 'reviewer@mediclaim.ai', password: 'reviewer123', role: 'reviewer' },
    ]
    for (const { password, ...user } of demoUsers) {
      if (!await findUserByEmail(user.email)) {
        await insertUser({ ...user, email: user.email.toLowerCase(), passwordHash: await hashPassword(password), createdAt: new Date().toISOString() })
      }
    }
  }

  const policies = [
    { policyNumber: 'POL-1108', name: 'Essential Care', coverageType: 'Individual health', annualLimit: 500000, currency: 'USD', status: 'active', benefits: ['Inpatient hospitalization', 'Emergency care', 'Diagnostic services'] },
    { policyNumber: 'POL-2091', name: 'Enhanced Family Care', coverageType: 'Family health', annualLimit: 1000000, currency: 'USD', status: 'active', benefits: ['Inpatient hospitalization', 'Outpatient procedures', 'Prescription medication'] },
    { policyNumber: 'POL-8854', name: 'Wellness Plus', coverageType: 'Individual health', annualLimit: 750000, currency: 'USD', status: 'active', benefits: ['Primary care', 'Orthopedic services', 'Diagnostic services'] },
  ]
  for (const policy of policies) await insertPolicy(policy)
}

await initializeDatabase()
await seedDatabase()

export const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }))

app.post('/api/auth/login', async (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase()
  const password = String(request.body?.password || '')
  const user = await findUserByEmail(email)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return response.status(401).json({ message: 'Email or password is incorrect.' })
  }
  response.json({ user: publicUser(user), token: signToken(user), message: 'Login successful.' })
})

app.post('/api/auth/register', async (request, response) => {
  const name = String(request.body?.name || '').trim()
  const email = String(request.body?.email || '').trim().toLowerCase()
  const password = String(request.body?.password || '')
  if (!name || !email || !password) {
    return response.status(400).json({ message: 'Please complete all required fields.' })
  }
  if (password.length < 8) {
    return response.status(400).json({ message: 'Password must be at least 8 characters.' })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ message: 'Enter a valid email address.' })
  }
  if (await findUserByEmail(email)) {
    return response.status(409).json({ message: 'This email is already registered.' })
  }

  const user = {
    id: `user-${randomUUID()}`,
    name,
    email,
    role: 'reviewer',
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  }
  try {
    const createdUser = await insertUser(user)
    response.status(201).json({ user: publicUser(createdUser), token: signToken(createdUser), message: 'Registration successful.' })
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ message: 'This email is already registered.' })
    throw error
  }
})

app.use('/api', requireAuthentication)

app.get('/api/users/me', (request, response) => response.json({ user: request.user }))
app.get('/api/users', requireRole('admin'), async (_request, response) => {
  response.json({ users: (await listUsers()).map(publicUser) })
})

app.post('/api/documents/analyze', express.raw({ type: 'application/octet-stream', limit: '15mb' }), async (request, response) => {
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    return response.status(400).json({ message: 'Choose a document to analyze.' })
  }

  const filename = String(request.query.filename || 'claim-document').split(/[\\/]/).pop()
  const contentType = String(request.headers['x-upload-content-type'] || 'application/octet-stream')
  const claimFields = (() => {
    try {
      const fields = JSON.parse(String(request.query.fields || '{}'))
      return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}
    } catch {
      return {}
    }
  })()

  const formData = new FormData()
  formData.append('file', new Blob([request.body], { type: contentType }), filename)
  for (const field of ['claimant', 'policy_number', 'provider', 'diagnosis']) {
    if (typeof claimFields[field] === 'string' && claimFields[field].trim()) {
      formData.append(field, claimFields[field].trim())
    }
  }
  if (Number.isFinite(Number(claimFields.amount)) && String(claimFields.amount ?? '').trim()) {
    formData.append('amount', String(claimFields.amount))
  }

  try {
    const aiResponse = await fetch(`${aiServiceUrl}/api/analyze`, { method: 'POST', body: formData })
    const result = await aiResponse.json().catch(() => ({}))
    if (!aiResponse.ok) {
      const message = result.detail || result.message || 'Document analysis could not be completed.'
      return response.status(aiResponse.status).json({ message })
    }
    response.json(result)
  } catch {
    response.status(503).json({ message: 'The document analysis service is unavailable. Start the Python AI service and try again.' })
  }
})

const procedureResultsHandler = async (request, response) => {
  const codes = String(request.body?.codes || '').trim()
  if (!codes) return response.status(400).json({ message: 'Enter one or more CPT procedure/service or ICD-10-CM diagnosis codes.' })
  if (codes.length > 5000) return response.status(400).json({ message: 'Procedure/service codes must be 5,000 characters or fewer.' })

  try {
    const aiResponse = await fetch(`${aiServiceUrl}/api/procedure-results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ codes }),
    })
    const result = await aiResponse.json().catch(() => ({}))
    if (!aiResponse.ok) {
      const message = result.detail || result.message || 'Procedure/service results could not be calculated.'
      return response.status(aiResponse.status).json({ message })
    }
    response.json(result)
  } catch {
    response.status(503).json({ message: 'The procedure/service reference is unavailable. Start the Python AI service and try again.' })
  }
}
app.post('/api/procedure-results', procedureResultsHandler)

app.get('/api/policies', async (request, response) => {
  const query = String(request.query.q || '').trim().toLowerCase()
  const policies = await listPolicies(query)
  response.json({ policies })
})

app.get('/api/policies/:policyNumber', async (request, response) => {
  const policy = await findPolicy(request.params.policyNumber)
  if (!policy) return response.status(404).json({ message: 'Policy was not found.' })
  response.json({ policy })
})

app.get('/api/claims', async (request, response) => {
  const { status, q } = request.query
  const claims = await listClaims({ status: String(status || ''), query: String(q || '') })
  response.json({ claims })
})

app.get('/api/claims/:claimId', async (request, response) => {
  const claim = await findClaim(request.params.claimId)
  if (!claim) return response.status(404).json({ message: 'Claim was not found.' })
  response.json({ claim })
})

app.delete('/api/claims/:claimId', requireRole('reviewer', 'admin'), async (request, response) => {
  const deleted = await deleteClaim(request.params.claimId)
  if (!deleted) return response.status(404).json({ message: 'Claim was not found.' })
  response.json({ message: 'Claim deleted successfully.' })
})

app.delete('/api/claims', requireRole('admin'), async (_request, response) => {
  const deletedCount = await deleteAllClaims()
  response.json({ message: `Deleted ${deletedCount} claim(s).`, deletedCount })
})

app.patch('/api/claims/:claimId/review', requireRole('reviewer', 'admin'), async (request, response) => {
  const requestedAction = String(request.body?.action || '').trim().toLowerCase()
  const action = ['reopen', 'reopened', 'reopen claim', 're-open'].includes(requestedAction)
    ? 'reopen'
    : requestedAction
  if (action === 'reopen') {
    const result = await reopenClaim(request.params.claimId, {
      reviewer: request.user.name,
      reviewerId: request.user.id,
      decidedAt: new Date().toISOString(),
      comment: String(request.body?.comment || '').trim(),
    })
    if (result.notFound) return response.status(404).json({ message: 'Claim was not found.' })
    if (result.invalidState) return response.status(409).json({ message: 'Only approved or rejected claims can be reopened.' })
    return response.json({ claim: result.claim, message: 'Claim reopened and returned to the review queue.' })
  }

  const statusByAction = { accept: 'accepted', reject: 'rejected', escalate: 'escalated' }
  if (!statusByAction[action]) {
    return response.status(400).json({ message: 'Choose accept, reject, or escalate as the review action.' })
  }

  const decidedAt = new Date().toISOString()
  const comment = String(request.body?.comment || '').trim()
  const decision = {
    action,
    reviewer: request.user.name,
    reviewerId: request.user.id,
    decidedAt,
    ...(comment ? { comment } : {}),
  }
  const claim = await saveClaimReview(request.params.claimId, decision, statusByAction[action])
  if (!claim) return response.status(404).json({ message: 'Claim was not found.' })
  response.json({ claim, message: `Final review status saved as ${claim.status}.` })
})

app.patch('/api/claims/:claimId/reconciliation', requireRole('reviewer', 'admin'), async (request, response) => {
  if (typeof request.body?.reconciled !== 'boolean') {
    return response.status(400).json({ message: 'Choose whether the claim and evidence are reconciled.' })
  }
  const reconciledAt = new Date().toISOString()
  const comment = String(request.body?.comment || '').trim()
  const reconciliation = {
    reconciled: request.body.reconciled,
    reviewer: request.user.name,
    reviewerId: request.user.id,
    reconciledAt,
    ...(comment ? { comment } : {}),
  }
  const claim = await saveClaimReconciliation(request.params.claimId, reconciliation)
  if (!claim) return response.status(404).json({ message: 'Claim was not found.' })
  response.json({ claim, message: reconciliation.reconciled ? 'Claim and evidence reconciliation saved.' : 'Reconciliation was reopened.' })
})

app.patch('/api/claims/:claimId/reopen', requireRole('reviewer', 'admin'), async (request, response) => {
  const result = await reopenClaim(request.params.claimId, {
    reviewer: request.user.name,
    reviewerId: request.user.id,
    decidedAt: new Date().toISOString(),
    comment: String(request.body?.comment || '').trim(),
  })
  if (result.notFound) return response.status(404).json({ message: 'Claim was not found.' })
  if (result.invalidState) return response.status(409).json({ message: 'Only approved or rejected claims can be reopened.' })
  response.json({ claim: result.claim, message: 'Claim reopened and returned to the review queue.' })
})

app.post('/api/claims', async (request, response) => {
  const body = request.body || {}
  const requiredFields = [
    ['claimant', body.claimant],
    ['provider', body.provider],
    ['diagnosis or treatment summary', body.diagnosis],
  ]
  const missing = requiredFields.filter(([, value]) => !String(value || '').trim()).map(([label]) => label)
  if (missing.length) return response.status(400).json({ message: `Please provide the ${missing.join(', ')}.` })

  const extractedFields = body.documentAnalysis?.extracted || body.documentAnalysis || {}
  const scannedFields = [
    ['Claimant', body.claimant],
    ['Policy', body.policyNumber],
    ['Provider', body.provider],
    ['Amount', body.amount],
    ['Diagnosis', body.diagnosis],
    ['Claimant', extractedFields.claimant],
    ['Policy', extractedFields.policyNumber || extractedFields.policy_number],
    ['Provider', extractedFields.provider],
    ['Amount', extractedFields.amount],
    ['Diagnosis', extractedFields.diagnosis],
  ]
  const unavailableFields = [...new Set(scannedFields
    .filter(([, value]) => String(value || '').trim().toUpperCase() === 'N/A')
    .map(([label]) => label))]
  const amount = Number(body.amount) || 0
  if (!Number.isFinite(amount) || amount < 0) return response.status(400).json({ message: 'Claim amount must be a non-negative number.' })
  if (body.treatmentItems !== undefined && !Array.isArray(body.treatmentItems)) {
    return response.status(400).json({ message: 'Treatment items must be a list.' })
  }
  const treatmentItems = (Array.isArray(body.treatmentItems) ? body.treatmentItems : [])
    .filter((item) => item && [item.code, item.name, item.billedPrice].some((value) => String(value ?? '').trim()))
    .map((item) => ({ code: String(item.code || '').trim(), name: String(item.name || '').trim(), billedPrice: Number(item.billedPrice) }))
  if (treatmentItems.some((item) => !/^[0-9]{5}$/.test(item.code) || !item.name || item.name.length > 200 || !Number.isFinite(item.billedPrice) || item.billedPrice < 0)) {
    return response.status(400).json({ message: 'Each billed treatment needs a five-digit CPT code, a treatment name, and a non-negative billed price.' })
  }
  const documents = Array.isArray(body.documents) ? body.documents.map((item) => String(item).trim()).filter(Boolean) : []
  const submittedAt = new Date().toISOString()
  const initialStatus = unavailableFields.length ? 'rejected' : 'submitted'
  const rejectionReason = unavailableFields.length ? `Missing fields: ${unavailableFields.join(', ')}` : null
  const claim = {
    id: `CLM-${randomUUID().slice(0, 8).toUpperCase()}`,
    claimant: String(body.claimant).trim(),
    policyNumber: String(body.policyNumber || '').trim(),
    provider: String(body.provider).trim(),
    amount,
    diagnosis: normalizeFiveDigitCodes(String(body.diagnosis).trim()),
    treatmentItems,
    documents,
    documentAnalysis: body.documentAnalysis && typeof body.documentAnalysis === 'object' ? body.documentAnalysis : null,
    status: initialStatus,
    createdAt: submittedAt,
    createdBy: request.user.id,
    auditTrail: [{
      type: 'claim_submitted',
      actor: request.user.name,
      actorId: request.user.id,
      at: submittedAt,
      ...(rejectionReason ? { reason: rejectionReason } : {}),
    }],
  }
  const createdClaim = await insertClaim(claim)
  response.status(201).json({
    claim: createdClaim,
    message: initialStatus === 'rejected' ? `Claim rejected. ${rejectionReason}.` : 'Claim submitted successfully.',
  })
})

app.get('/api/dashboard/metrics', async (_request, response) => {
  response.json({ metrics: await getDashboardMetrics() })
})

app.use((error, _request, response, next) => {
  if (response.headersSent) return next(error)
  console.error(error)
  response.status(500).json({ message: 'The service could not complete the request.' })
})

if (process.env.NODE_ENV !== 'test' || process.env.USE_IN_MEMORY_DB === 'true') {
  const port = Number(process.env.PORT) || 3001
  app.listen(port, () => console.log(`MediClaim API listening on http://localhost:${port}`))
}
