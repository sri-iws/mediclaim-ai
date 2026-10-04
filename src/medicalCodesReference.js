import { readSheet } from 'read-excel-file/browser'

const WORKBOOK_URL = '/medical_codes.xlsx'
const REFERENCE = 'medical_codes.xlsx'
const REFERENCE_VERSION = '2024 example data'
const CPT_PATTERN = /^(?:\d{5}|\d{4}[FTU])$/i
const ICD10_PATTERN = /^[A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?$/i

let workbookPromise

function rowsToObjects(rows) {
  const [headers = [], ...body] = rows
  const names = headers.map((header) => String(header ?? '').trim())
  return body.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])))
}

async function loadWorkbook() {
  const response = await fetch(WORKBOOK_URL)
  if (!response.ok) throw new Error(`Unable to load ${REFERENCE} (HTTP ${response.status}).`)
  const blob = await response.blob()
  const [cptRows, diagnosisRows] = await Promise.all([readSheet(blob, 'CPT Codes'), readSheet(blob, 'Diagnosis Codes')])
  const cpt = new Map()
  for (const item of rowsToObjects(cptRows)) {
    const code = String(item['CPT Code'] ?? '').trim().toUpperCase()
    if (code) cpt.set(code, item)
  }
  const icd10 = new Map()
  for (const item of rowsToObjects(diagnosisRows)) {
    const code = String(item['ICD-10 Code'] ?? '').trim().toUpperCase()
    if (code) icd10.set(code, item)
  }
  return { cpt, icd10 }
}

function getWorkbook() {
  workbookPromise ||= loadWorkbook().catch((error) => {
    workbookPromise = undefined
    throw error
  })
  return workbookPromise
}

function priceRange(item) {
  if (String(item['Status'] ?? '').trim().toLowerCase() !== 'active') return undefined
  const minimum = Number(item['Min Cost'])
  const maximum = Number(item['Max Cost'])
  if (item['Min Cost'] == null || item['Max Cost'] == null || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum) return undefined
  return {
    reference_min: minimum,
    reference_max: maximum,
    currency: 'USD',
    reference: REFERENCE,
    reference_version: REFERENCE_VERSION,
    reference_status: 'historical_example',
    source_note: String(item['First Found'] || 'Historical receipt example'),
    authoritative: false,
  }
}

// Compares codes and min/max prices from the local workbook; returns the same shape as the AI service.
export async function verifyCodesWithWorkbook(codes) {
  const { cpt, icd10 } = await getWorkbook()
  const procedures = []
  const diagnoses = []
  const ignored = []
  let checked = 0
  const base = {
    is_valid_code: true,
    verification_status: 'verified_fallback',
    reference_version: REFERENCE_VERSION,
    reference: `${REFERENCE} (historical/example data)`,
  }

  for (const rawCode of [...new Set(codes.map((code) => String(code).trim().toUpperCase()).filter(Boolean))]) {
    if (CPT_PATTERN.test(rawCode)) {
      checked += 1
      const item = cpt.get(rawCode)
      if (!item) {
        ignored.push({ value: rawCode, system: 'CPT', reason: `No exact match was found in ${REFERENCE}; code unverified.` })
        continue
      }
      const cost = priceRange(item)
      procedures.push({
        ...base,
        system: 'CPT',
        code: rawCode,
        description: String(item['Description'] ?? '').trim(),
        evidence: [rawCode],
        explanation: `${REFERENCE} contains an exact entry for ${rawCode}.`,
        ...(cost ? { cost } : {}),
      })
    } else if (ICD10_PATTERN.test(rawCode)) {
      checked += 1
      const item = icd10.get(rawCode)
      if (!item) {
        ignored.push({ value: rawCode, system: 'ICD-10-CM', reason: `No exact match was found in ${REFERENCE}; code unverified.` })
        continue
      }
      diagnoses.push({
        ...base,
        system: 'ICD-10-CM',
        code: rawCode,
        description: String(item['Diagnosis Description'] ?? '').trim(),
        evidence: [rawCode],
        explanation: `${REFERENCE} contains an exact entry for ${rawCode}.`,
        severity: String(item['Severity'] ?? '').trim(),
        related_symptoms: String(item['Related Symptoms'] ?? '').trim(),
        common_procedures: String(item['Common Procedures'] ?? '').trim(),
      })
    } else {
      ignored.push({ value: rawCode, reason: `Not a CPT or ICD-10-CM code present in ${REFERENCE}; ignored.` })
    }
  }

  const verifiedCount = procedures.length + diagnoses.length
  const pricedCount = procedures.filter((procedure) => procedure.cost).length
  return {
    procedures,
    diagnoses,
    code_relationships: [],
    ignored_codes: ignored,
    engine: 'medical_codes_xlsx',
    reference: REFERENCE,
    reference_version: REFERENCE_VERSION,
    reference_status: verifiedCount && ignored.length ? 'partial_reference_gap' : ignored.length ? 'reference_gap' : verifiedCount ? 'fallback' : 'no_valid_codes',
    api_status: 'not_used',
    fallback_count: verifiedCount,
    workbook_checked_count: checked,
    pricing_workbook_checked_count: procedures.length,
    priced_cpt_count: pricedCount,
    authoritative_priced_cpt_count: 0,
    pricing_reference_status: pricedCount ? 'historical_example' : 'unavailable',
    verified_count: verifiedCount,
    ignored_count: ignored.length,
    message: `${verifiedCount} code(s) matched in ${REFERENCE}; ${ignored.length} remain unverified. Workbook data is historical/example data, not authoritative.`,
    disclaimer: 'Workbook matches are historical/example data and do not constitute coverage or reimbursement decisions.',
  }
}
