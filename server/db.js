import process from 'node:process'

let pool
if (process.env.NODE_ENV === 'test' || process.env.USE_IN_MEMORY_DB === 'true') {
  const { DataType, newDb } = await import('pg-mem')
  const memoryDatabase = newDb({ autoCreateForeignKeyIndices: true })
  memoryDatabase.public.registerFunction({
    name: 'jsonb_array_length',
    args: [DataType.jsonb],
    returns: DataType.integer,
    implementation: (value) => Array.isArray(value) ? value.length : 0,
  })
  const { Pool } = memoryDatabase.adapters.createPg()
  pool = new Pool()
} else {
  const { Pool } = await import('pg')
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://mediclaim:mediclaim@localhost:5432/mediclaim',
    ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  })
}

export { pool }

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'auditor', 'reviewer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS policies (
      policy_number TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      coverage_type TEXT NOT NULL,
      annual_limit NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'active',
      benefits JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      claimant TEXT NOT NULL,
      policy_number TEXT NOT NULL,
      provider TEXT NOT NULL,
      amount NUMERIC NOT NULL CHECK (amount >= 0),
      diagnosis TEXT NOT NULL,
      documents JSONB NOT NULL DEFAULT '[]'::jsonb,
      document_analysis JSONB,
      treatment_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      review_decision JSONB,
      reconciliation JSONB,
      audit_trail JSONB NOT NULL DEFAULT '[]'::jsonb,
      issues JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary TEXT
    );

    ALTER TABLE claims ADD COLUMN IF NOT EXISTS reconciliation JSONB;
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS treatment_items JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS claims_created_at_idx ON claims (created_at DESC);
    CREATE INDEX IF NOT EXISTS claims_status_idx ON claims (LOWER(status));
  `)
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
    benefits: row.benefits,
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
    documents: row.documents,
    documentAnalysis: row.document_analysis,
    treatmentItems: row.treatment_items || [],
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
    ...(row.review_decision ? { reviewDecision: row.review_decision } : {}),
    ...(row.reconciliation ? { reconciliation: row.reconciliation } : {}),
    auditTrail: row.audit_trail,
    issues: row.issues,
    ...(row.summary ? { summary: row.summary } : {}),
  }
}

export async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id])
  return mapUser(rows[0])
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email])
  return mapUser(rows[0])
}

export async function listUsers() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at, name')
  return rows.map(mapUser)
}

export async function deleteDemoUsers() {
  await pool.query(`
    DELETE FROM users
    WHERE (id = 'user-admin-1' AND email = 'admin@mediclaim.ai')
       OR (id = 'user-auditor-1' AND email = 'auditor@mediclaim.ai')
       OR (id = 'user-reviewer-1' AND email = 'reviewer@mediclaim.ai')
  `)
}

export async function insertUser(user) {
  const { rows } = await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [user.id, user.name, user.email, user.passwordHash, user.role, user.createdAt],
  )
  return mapUser(rows[0])
}

export async function insertPolicy(policy) {
  const { rows } = await pool.query(
    `INSERT INTO policies (policy_number, name, coverage_type, annual_limit, currency, status, benefits)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (policy_number) DO NOTHING RETURNING *`,
    [policy.policyNumber, policy.name, policy.coverageType, policy.annualLimit, policy.currency || 'USD', policy.status || 'active', JSON.stringify(policy.benefits || [])],
  )
  return mapPolicy(rows[0])
}

export async function listPolicies(query = '') {
  const { rows } = await pool.query(
    `SELECT * FROM policies
     WHERE $1 = '' OR LOWER(policy_number || ' ' || name || ' ' || coverage_type) LIKE '%' || $1 || '%'
     ORDER BY policy_number`,
    [query.toLowerCase()],
  )
  return rows.map(mapPolicy)
}

export async function findPolicy(policyNumber) {
  const { rows } = await pool.query('SELECT * FROM policies WHERE LOWER(policy_number) = LOWER($1)', [policyNumber])
  return mapPolicy(rows[0])
}

export async function insertClaim(claim) {
  const { rows } = await pool.query(
    `INSERT INTO claims
      (id, claimant, policy_number, provider, amount, diagnosis, documents, document_analysis, treatment_items, status, created_at, created_by, review_decision, reconciliation, audit_trail, issues, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17)
     RETURNING *`,
    [claim.id, claim.claimant, claim.policyNumber, claim.provider, claim.amount, claim.diagnosis, JSON.stringify(claim.documents || []), JSON.stringify(claim.documentAnalysis), JSON.stringify(claim.treatmentItems || []), claim.status || 'submitted', claim.createdAt, claim.createdBy || null, JSON.stringify(claim.reviewDecision ?? null), JSON.stringify(claim.reconciliation ?? null), JSON.stringify(claim.auditTrail || []), JSON.stringify(claim.issues || []), claim.summary || null],
  )
  return mapClaim(rows[0])
}

export async function listClaims({ status = '', query = '' } = {}) {
  const { rows: submittedRows } = await pool.query(
    `SELECT id, claimant, policy_number, provider, diagnosis, document_analysis
     FROM claims
     WHERE LOWER(status) = 'submitted'`,
  )
  for (const row of submittedRows) {
    const analysis = row.document_analysis || {}
    const extracted = analysis.extracted || {}
    const hasUnavailableField = [
      row.claimant,
      row.policy_number,
      row.provider,
      row.diagnosis,
      analysis.claimant,
      analysis.policyNumber,
      analysis.policy_number,
      analysis.provider,
      analysis.amount,
      analysis.diagnosis,
      extracted.claimant,
      extracted.policyNumber,
      extracted.policy_number,
      extracted.provider,
      extracted.amount,
      extracted.diagnosis,
    ].some((value) => String(value || '').trim().toUpperCase() === 'N/A')
    if (hasUnavailableField) {
      await pool.query("UPDATE claims SET status = 'rejected' WHERE id = $1", [row.id])
    }
  }
  const { rows } = await pool.query(
    `SELECT * FROM claims
     WHERE ($1 = '' OR LOWER(status) = LOWER($1))
       AND ($2 = '' OR LOWER(CONCAT_WS(' ', id, claimant, policy_number, provider)) LIKE '%' || LOWER($2) || '%')
     ORDER BY created_at DESC`,
    [status, query],
  )
  return rows.map(mapClaim)
}

export async function findClaim(id) {
  const { rows } = await pool.query('SELECT * FROM claims WHERE id = $1', [id])
  return mapClaim(rows[0])
}

export async function deleteClaim(id) {
  const { rowCount } = await pool.query('DELETE FROM claims WHERE id = $1', [id])
  return rowCount > 0
}

export async function deleteAllClaims() {
  const { rowCount } = await pool.query('DELETE FROM claims')
  return rowCount
}

export async function saveClaimReview(id, decision, status) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query('SELECT * FROM claims WHERE id = $1 FOR UPDATE', [id])
    if (!current.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const existingAudit = current.rows[0].audit_trail || []
    const previousStatus = current.rows[0].status || 'submitted'
    const auditEvent = {
      type: 'review_decision',
      action: decision.action,
      actor: decision.reviewer,
      actorId: decision.reviewerId,
      fromStatus: previousStatus,
      toStatus: status,
      at: decision.decidedAt,
      ...(decision.comment ? { comment: decision.comment } : {}),
    }
    const auditTrail = [...existingAudit, auditEvent]
    const { rows } = await client.query(
      `UPDATE claims SET status = $1, review_decision = $2::jsonb, audit_trail = $3::jsonb
       WHERE id = $4 RETURNING *`,
      [status, JSON.stringify(decision), JSON.stringify(auditTrail), id],
    )
    await client.query('COMMIT')
    return mapClaim(rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function saveClaimReconciliation(id, reconciliation) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query('SELECT audit_trail FROM claims WHERE id = $1 FOR UPDATE', [id])
    if (!current.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const event = {
      type: reconciliation.reconciled ? 'evidence_reconciled' : 'reconciliation_reopened',
      actor: reconciliation.reviewer,
      actorId: reconciliation.reviewerId,
      at: reconciliation.reconciledAt,
      ...(reconciliation.comment ? { comment: reconciliation.comment } : {}),
    }
    const auditTrail = [...(current.rows[0].audit_trail || []), event]
    const { rows } = await client.query(
      `UPDATE claims SET reconciliation = $1::jsonb, audit_trail = $2::jsonb
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(reconciliation), JSON.stringify(auditTrail), id],
    )
    await client.query('COMMIT')
    return mapClaim(rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function reopenClaim(id, { reviewer, reviewerId, decidedAt, comment = '' }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query('SELECT status, audit_trail FROM claims WHERE id = $1 FOR UPDATE', [id])
    if (!current.rows[0]) {
      await client.query('ROLLBACK')
      return { notFound: true }
    }
    if (!['accepted', 'approved', 'rejected'].includes(String(current.rows[0].status).toLowerCase())) {
      await client.query('ROLLBACK')
      return { invalidState: true }
    }
    const auditEvent = {
      type: 'claim_reopened',
      actor: reviewer,
      actorId: reviewerId,
      fromStatus: current.rows[0].status,
      toStatus: 'reopened',
      at: decidedAt,
      ...(comment ? { comment } : {}),
    }
    const auditTrail = [...(current.rows[0].audit_trail || []), auditEvent]
    const { rows } = await client.query(
      `UPDATE claims SET status = 'reopened', review_decision = NULL, reconciliation = NULL, audit_trail = $1::jsonb
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(auditTrail), id],
    )
    await client.query('COMMIT')
    return { claim: mapClaim(rows[0]) }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getDashboardMetrics() {
  const [total, inReview, itemsToCheck, evidenceFiles, statuses] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM claims'),
    pool.query("SELECT COUNT(*)::int AS count FROM claims WHERE LOWER(status) IN ('submitted', 'reopened', 'pending review', 'escalated')"),
    pool.query('SELECT COUNT(*)::int AS count FROM claims WHERE jsonb_array_length(issues) > 0'),
    pool.query('SELECT COALESCE(SUM(jsonb_array_length(documents)), 0)::int AS count FROM claims'),
    pool.query('SELECT LOWER(status) AS status, COUNT(*)::int AS count FROM claims GROUP BY LOWER(status)'),
  ])
  return {
    totalClaims: total.rows[0].count,
    inReview: inReview.rows[0].count,
    itemsToCheck: itemsToCheck.rows[0].count,
    evidenceFiles: evidenceFiles.rows[0].count,
    byStatus: Object.fromEntries(statuses.rows.map((row) => [row.status, row.count])),
  }
}
