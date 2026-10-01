import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const databasePath = process.env.NODE_ENV === 'test' || process.env.USE_IN_MEMORY_DB === 'true'
  ? ':memory:'
  : (process.env.SQLITE_DB_PATH || path.join('server', 'data', 'mediclaim.sqlite'))

if (databasePath !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })
}

export const database = new Database(databasePath)
database.pragma('foreign_keys = ON')
database.pragma('busy_timeout = 5000')
if (databasePath !== ':memory:') database.pragma('journal_mode = WAL')

function parseJson(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function json(value, fallback = null) {
  return JSON.stringify(value ?? fallback)
}

function mapUser(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function mapPolicy(row) {
  if (!row) return null
  return {
    policyNumber: row.policy_number,
    name: row.name,
    coverageType: row.coverage_type,
    annualLimit: Number(row.annual_limit),
    currency: row.currency,
    status: row.status,
    benefits: parseJson(row.benefits, []),
  }
}

function mapClaim(row) {
  if (!row) return null
  return {
    id: row.id,
    claimant: row.claimant,
    policyNumber: row.policy_number,
    provider: row.provider,
    amount: Number(row.amount),
    diagnosis: row.diagnosis,
    documents: parseJson(row.documents, []),
    documentAnalysis: parseJson(row.document_analysis),
    treatmentItems: parseJson(row.treatment_items, []),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
    ...(parseJson(row.review_decision) ? { reviewDecision: parseJson(row.review_decision) } : {}),
    ...(parseJson(row.reconciliation) ? { reconciliation: parseJson(row.reconciliation) } : {}),
    auditTrail: parseJson(row.audit_trail, []),
    issues: parseJson(row.issues, []),
    ...(row.summary ? { summary: row.summary } : {}),
  }
}

function hasColumn(table, column) {
  return database.pragma(`table_info(${table})`).some((entry) => entry.name === column)
}

export async function initializeDatabase() {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'auditor', 'reviewer')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policies (
      policy_number TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      coverage_type TEXT NOT NULL,
      annual_limit REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'active',
      benefits TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      claimant TEXT NOT NULL,
      policy_number TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
      diagnosis TEXT NOT NULL,
      documents TEXT NOT NULL DEFAULT '[]',
      document_analysis TEXT,
      treatment_items TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'submitted',
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      review_decision TEXT,
      reconciliation TEXT,
      audit_trail TEXT NOT NULL DEFAULT '[]',
      issues TEXT NOT NULL DEFAULT '[]',
      summary TEXT
    );
  `)

  // Keep older SQLite files forward-compatible as the schema gains fields.
  if (!hasColumn('claims', 'reconciliation')) database.exec('ALTER TABLE claims ADD COLUMN reconciliation TEXT')
  if (!hasColumn('claims', 'treatment_items')) database.exec("ALTER TABLE claims ADD COLUMN treatment_items TEXT NOT NULL DEFAULT '[]'")
  if (!hasColumn('claims', 'document_analysis')) database.exec('ALTER TABLE claims ADD COLUMN document_analysis TEXT')
  database.exec(`
    CREATE INDEX IF NOT EXISTS claims_created_at_idx ON claims (created_at DESC);
    CREATE INDEX IF NOT EXISTS claims_status_idx ON claims (LOWER(status));
  `)
  database.pragma('user_version = 1')
}

export async function findUserById(id) {
  return mapUser(database.prepare('SELECT * FROM users WHERE id = ?').get(id))
}

export async function findUserByEmail(email) {
  return mapUser(database.prepare('SELECT * FROM users WHERE email = ?').get(email))
}

export async function listUsers() {
  return database.prepare('SELECT * FROM users ORDER BY created_at, name').all().map(mapUser)
}

export async function deleteDemoUsers() {
  database.prepare(`
    DELETE FROM users
    WHERE (id = 'user-admin-1' AND email = 'admin@mediclaim.ai')
       OR (id = 'user-auditor-1' AND email = 'auditor@mediclaim.ai')
       OR (id = 'user-reviewer-1' AND email = 'reviewer@mediclaim.ai')
  `).run()
}

export async function insertUser(user) {
  database.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, user.name, user.email, user.passwordHash, user.role, user.createdAt)
  return findUserById(user.id)
}

export async function insertPolicy(policy) {
  const result = database.prepare(`
    INSERT INTO policies (policy_number, name, coverage_type, annual_limit, currency, status, benefits)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (policy_number) DO NOTHING
  `).run(policy.policyNumber, policy.name, policy.coverageType, policy.annualLimit, policy.currency || 'USD', policy.status || 'active', json(policy.benefits, []))
  return result.changes ? findPolicy(policy.policyNumber) : null
}

export async function listPolicies(query = '') {
  return database.prepare(`
    SELECT * FROM policies
    WHERE ? = '' OR LOWER(policy_number || ' ' || name || ' ' || coverage_type) LIKE '%' || ? || '%'
    ORDER BY policy_number
  `).all(query.toLowerCase(), query.toLowerCase()).map(mapPolicy)
}

export async function findPolicy(policyNumber) {
  return mapPolicy(database.prepare('SELECT * FROM policies WHERE LOWER(policy_number) = LOWER(?)').get(policyNumber))
}

export async function insertClaim(claim) {
  database.prepare(`
    INSERT INTO claims
      (id, claimant, policy_number, provider, amount, diagnosis, documents, document_analysis, treatment_items, status, created_at, created_by, review_decision, reconciliation, audit_trail, issues, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(claim.id, claim.claimant, claim.policyNumber, claim.provider, claim.amount, claim.diagnosis, json(claim.documents, []), json(claim.documentAnalysis), json(claim.treatmentItems, []), claim.status || 'submitted', claim.createdAt, claim.createdBy || null, json(claim.reviewDecision), json(claim.reconciliation), json(claim.auditTrail, []), json(claim.issues, []), claim.summary || null)
  return findClaim(claim.id)
}

export async function listClaims({ status = '', query = '' } = {}) {
  const submittedRows = database.prepare(`
    SELECT id, claimant, policy_number, provider, diagnosis, document_analysis
    FROM claims WHERE LOWER(status) = 'submitted'
  `).all()
  const rejectUnavailable = database.prepare("UPDATE claims SET status = 'rejected' WHERE id = ?")
  for (const row of submittedRows) {
    const analysis = parseJson(row.document_analysis, {}) || {}
    const extracted = analysis.extracted || {}
    const hasUnavailableField = [
      row.claimant, row.policy_number, row.provider, row.diagnosis,
      analysis.claimant, analysis.policyNumber, analysis.policy_number, analysis.provider, analysis.amount, analysis.diagnosis,
      extracted.claimant, extracted.policyNumber, extracted.policy_number, extracted.provider, extracted.amount, extracted.diagnosis,
    ].some((value) => String(value || '').trim().toUpperCase() === 'N/A')
    if (hasUnavailableField) rejectUnavailable.run(row.id)
  }
  return database.prepare(`
    SELECT * FROM claims
    WHERE (? = '' OR LOWER(status) = LOWER(?))
      AND (? = '' OR LOWER(id || ' ' || claimant || ' ' || policy_number || ' ' || provider) LIKE '%' || LOWER(?) || '%')
    ORDER BY created_at DESC
  `).all(status, status, query, query).map(mapClaim)
}

export async function findClaim(id) {
  return mapClaim(database.prepare('SELECT * FROM claims WHERE id = ?').get(id))
}

export async function deleteClaim(id) {
  return database.prepare('DELETE FROM claims WHERE id = ?').run(id).changes > 0
}

export async function deleteAllClaims() {
  return database.prepare('DELETE FROM claims').run().changes
}

export async function saveClaimReview(id, decision, status) {
  return database.transaction(() => {
    const current = database.prepare('SELECT * FROM claims WHERE id = ?').get(id)
    if (!current) return null
    const auditEvent = {
      type: 'review_decision', action: decision.action, actor: decision.reviewer,
      actorId: decision.reviewerId, fromStatus: current.status || 'submitted', toStatus: status,
      at: decision.decidedAt, ...(decision.comment ? { comment: decision.comment } : {}),
    }
    const auditTrail = [...parseJson(current.audit_trail, []), auditEvent]
    database.prepare('UPDATE claims SET status = ?, review_decision = ?, audit_trail = ? WHERE id = ?')
      .run(status, json(decision), json(auditTrail), id)
    return mapClaim(database.prepare('SELECT * FROM claims WHERE id = ?').get(id))
  })()
}

export async function saveClaimReconciliation(id, reconciliation) {
  return database.transaction(() => {
    const current = database.prepare('SELECT audit_trail FROM claims WHERE id = ?').get(id)
    if (!current) return null
    const event = {
      type: reconciliation.reconciled ? 'evidence_reconciled' : 'reconciliation_reopened',
      actor: reconciliation.reviewer, actorId: reconciliation.reviewerId, at: reconciliation.reconciledAt,
      ...(reconciliation.comment ? { comment: reconciliation.comment } : {}),
    }
    const auditTrail = [...parseJson(current.audit_trail, []), event]
    database.prepare('UPDATE claims SET reconciliation = ?, audit_trail = ? WHERE id = ?')
      .run(json(reconciliation), json(auditTrail), id)
    return mapClaim(database.prepare('SELECT * FROM claims WHERE id = ?').get(id))
  })()
}

export async function reopenClaim(id, { reviewer, reviewerId, decidedAt, comment = '' }) {
  return database.transaction(() => {
    const current = database.prepare('SELECT status, audit_trail FROM claims WHERE id = ?').get(id)
    if (!current) return { notFound: true }
    if (!['accepted', 'approved', 'rejected'].includes(String(current.status).toLowerCase())) return { invalidState: true }
    const auditEvent = {
      type: 'claim_reopened', actor: reviewer, actorId: reviewerId, fromStatus: current.status,
      toStatus: 'reopened', at: decidedAt, ...(comment ? { comment } : {}),
    }
    const auditTrail = [...parseJson(current.audit_trail, []), auditEvent]
    database.prepare("UPDATE claims SET status = 'reopened', review_decision = NULL, reconciliation = NULL, audit_trail = ? WHERE id = ?")
      .run(json(auditTrail), id)
    return { claim: mapClaim(database.prepare('SELECT * FROM claims WHERE id = ?').get(id)) }
  })()
}

export async function updateClaimStatus(id, status) {
  database.prepare('UPDATE claims SET status = ? WHERE id = ?').run(status, id)
}

export async function getDashboardMetrics() {
  const count = (sql) => database.prepare(sql).get().count
  const byStatus = database.prepare('SELECT LOWER(status) AS status, COUNT(*) AS count FROM claims GROUP BY LOWER(status)').all()
  const documents = database.prepare('SELECT documents FROM claims').all()
  const issues = database.prepare('SELECT issues FROM claims').all()
  return {
    totalClaims: count('SELECT COUNT(*) AS count FROM claims'),
    inReview: database.prepare("SELECT COUNT(*) AS count FROM claims WHERE LOWER(status) IN ('submitted', 'reopened', 'pending review', 'escalated')").get().count,
    itemsToCheck: issues.filter((row) => parseJson(row.issues, []).length > 0).length,
    evidenceFiles: documents.reduce((total, row) => total + parseJson(row.documents, []).length, 0),
    byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.count])),
  }
}

export function closeDatabase() {
  if (database.open) database.close()
}