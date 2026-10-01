import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import { initializeDatabase, pool } from './db.js'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = process.env.MEDICLAIM_JSON_IMPORT_PATH || path.join(currentDirectory, 'data', 'mediclaim.json')

try {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  await initializeDatabase()

  for (const user of source.users || []) {
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [user.id, user.name, user.email.toLowerCase(), user.passwordHash, user.role, user.createdAt],
    )
  }

  for (const policy of source.policies || []) {
    await pool.query(
      `INSERT INTO policies (policy_number, name, coverage_type, annual_limit, currency, status, benefits)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT DO NOTHING`,
      [policy.policyNumber, policy.name, policy.coverageType, policy.annualLimit, policy.currency || 'USD', policy.status || 'active', JSON.stringify(policy.benefits || [])],
    )
  }

  for (const claim of source.claims || []) {
    await pool.query(
      `INSERT INTO claims
        (id, claimant, policy_number, provider, amount, diagnosis, documents, document_analysis, treatment_items, status, created_at, created_by, review_decision, audit_trail, issues, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16)
       ON CONFLICT DO NOTHING`,
      [claim.id, claim.claimant, claim.policyNumber || '', claim.provider, claim.amount || 0, claim.diagnosis || claim.summary || '', JSON.stringify(claim.documents || []), JSON.stringify(claim.documentAnalysis ?? null), JSON.stringify(claim.treatmentItems || []), claim.status || 'submitted', claim.createdAt || new Date().toISOString(), claim.createdBy || null, JSON.stringify(claim.reviewDecision ?? null), JSON.stringify(claim.auditTrail || []), JSON.stringify(claim.issues || []), claim.summary || null],
    )
  }

  console.log(`Imported JSON data from ${sourcePath} into PostgreSQL (existing IDs/emails were left unchanged).`)
} catch (error) {
  console.error(`PostgreSQL import failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
