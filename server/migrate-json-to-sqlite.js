import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import {
  closeDatabase,
  findClaim,
  findUserByEmail,
  findUserById,
  initializeDatabase,
  insertClaim,
  insertPolicy,
  insertUser,
} from './db.js'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = process.env.MEDICLAIM_JSON_IMPORT_PATH || path.join(currentDirectory, 'data', 'mediclaim.json')

try {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  await initializeDatabase()

  for (const user of source.users || []) {
    if (!await findUserById(user.id) && !await findUserByEmail(user.email.toLowerCase())) {
      await insertUser({ ...user, email: user.email.toLowerCase() })
    }
  }

  for (const policy of source.policies || []) await insertPolicy(policy)

  for (const claim of source.claims || []) {
    if (await findClaim(claim.id)) continue
    await insertClaim({
      ...claim,
      policyNumber: claim.policyNumber || '',
      amount: claim.amount || 0,
      diagnosis: claim.diagnosis || claim.summary || '',
      createdAt: claim.createdAt || new Date().toISOString(),
    })
  }

  console.log(`Imported JSON data from ${sourcePath} into SQLite (existing records were left unchanged).`)
} catch (error) {
  console.error(`SQLite import failed: ${error.message}`)
  process.exitCode = 1
} finally {
  closeDatabase()
}