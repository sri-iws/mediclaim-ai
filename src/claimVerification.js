const CPT_CODE_PATTERN = /^(?:\d{5}|\d{4}[FTU])$/i
const HCPCS_CODE_PATTERN = /^[A-HJ-NPRSTV]\d{4}$/i
const ICD10_CODE_PATTERN = /^[A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?$/i
const DELIMITED_CODE_PATTERN = /(?<![A-Z0-9.])(?:\d{5}|\d{4}[FTU]|[A-HJ-NPRSTV]\d{4}|[A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?)(?![A-Z0-9.])/gi

function isSupportedCode(value) {
  return CPT_CODE_PATTERN.test(value) || HCPCS_CODE_PATTERN.test(value) || ICD10_CODE_PATTERN.test(value)
}

function codesInDelimitedText(text) {
  const codes = []
  const groups = String(text || '').matchAll(/\(([^()]*)\)|\{([^{}]*)\}/g)
  for (const [, parenthesized, braced] of groups) {
    const content = parenthesized ?? braced ?? ''
    for (const match of content.matchAll(DELIMITED_CODE_PATTERN)) {
      codes.push(match[0].toUpperCase())
    }
  }
  return codes
}

export function getClaimVerificationCodes(claim) {
  const analysis = claim?.documentAnalysis || {}
  const extracted = analysis.extracted || {}
  const extractedFields = analysis.extracted_fields || analysis.extractedFields || {}
  const checks = analysis.codeChecks || extracted.codeChecks || {}
  const procedureCodes = [
    ...(claim?.treatmentItems || []).map((item) => item.code),
    ...(extracted.cptCodes?.length ? extracted.cptCodes : analysis.cptCodes || []),
    ...(extracted.hcpcsCodes?.length ? extracted.hcpcsCodes : analysis.hcpcsCodes || []),
    ...(extracted.procedureAmounts || analysis.procedureAmounts || []).map((item) => item.code),
    ...(!extracted.cptCodes?.length && !analysis.cptCodes?.length && checks.procedure?.system === 'CPT' && checks.procedure.value
      ? [checks.procedure.value]
      : []),
    ...(!extracted.cptCodes?.length && !analysis.cptCodes?.length && !checks.procedure?.system && extracted.procedureCode
      ? [extracted.procedureCode]
      : []),
  ]
  const diagnosisCodes = [
    ...(extracted.diagnosisCodes?.length ? extracted.diagnosisCodes : analysis.diagnosisCodes || extractedFields.diagnosisCodes || []),
    ...(!extracted.diagnosisCodes?.length && !analysis.diagnosisCodes?.length && (extracted.diagnosisCode || analysis.diagnosisCode)
      ? [extracted.diagnosisCode || analysis.diagnosisCode]
      : []),
    ...(checks.diagnosis?.system === 'ICD-10-CM' && checks.diagnosis.value ? [checks.diagnosis.value] : []),
  ]
  const sourceText = [
    claim?.diagnosis,
    claim?.summary,
    analysis.extracted_text,
    analysis.extractedText,
    extracted.diagnosis,
    extractedFields.diagnosis,
  ].filter(Boolean).join('\n')
  return [...new Set([...procedureCodes, ...diagnosisCodes, ...codesInDelimitedText(sourceText)]
    .map((code) => String(code).trim().toUpperCase())
    .filter(isSupportedCode))]
}

export function assessClaimReference(claim, result) {
  const procedures = result?.procedures || []
  const diagnoses = result?.diagnoses || []
  const ignoredCodes = result?.ignored_codes || []
  const extracted = claim?.documentAnalysis?.extracted || {}
  const procedureAmounts = claim?.treatmentItems?.length
    ? claim.treatmentItems.map((item) => ({ code: item.code, amount: item.billedPrice }))
    : extracted.procedureAmounts || claim?.documentAnalysis?.procedureAmounts || []
  const findings = []
  const verifiedCount = procedures.length + diagnoses.length
  const priceChecks = []
  let significantVariance = false
  let referenceGap = ignoredCodes.length > 0
  let pricingDataComplete = false

  if (!getClaimVerificationCodes(claim).length) {
    referenceGap = true
    findings.push('No supported procedure or diagnosis codes were detected in this claim. Reference verification is incomplete.')
  }
  if (ignoredCodes.length) {
    findings.push(`${ignoredCodes.length} submitted code${ignoredCodes.length === 1 ? '' : 's'} could not be matched in the available online, licensed, or medical_codes.xlsx reference; verify the source document and code set.`)
  }

  if (procedureAmounts.length) {
    for (const item of procedureAmounts) {
      const procedure = procedures.find((candidate) => candidate.code === String(item.code).toUpperCase())
      const minimum = procedure?.cost?.reference_min ?? procedure?.cost?.observed_min_allowed
      const maximum = procedure?.cost?.reference_max ?? procedure?.cost?.observed_max_allowed
      const amount = Number(item.amount)
      if (!procedure || !Number.isFinite(minimum) || !Number.isFinite(maximum) || !Number.isFinite(amount)) {
        priceChecks.push({ code: item.code, amount, result: 'range_unavailable' })
        findings.push(`No price data was provided by the code reference for the billed amount beside CPT ${item.code}.`)
        continue
      }

      const inRange = amount >= minimum && amount <= maximum
      priceChecks.push({ code: item.code, amount, minimum, maximum, result: inRange ? 'within_range' : 'outside_range' })
      if (inRange) {
        findings.push(`The billed price for CPT ${item.code} is within its available reference range; this is not a coverage or reimbursement determination.`)
      } else {
        significantVariance = true
        findings.push(`The billed price for CPT ${item.code} is outside its available reference range ${minimum.toLocaleString()}–${maximum.toLocaleString()}; verify the bill and code assignment.`)
      }
    }
    const extractedCptCodes = getClaimVerificationCodes(claim).filter((code) => CPT_CODE_PATTERN.test(code))
    const submittedCptCodes = extractedCptCodes.length
      ? extractedCptCodes
      : [...new Set(procedureAmounts.map((item) => String(item.code).toUpperCase()))]
    const checkedCptCodes = new Set(priceChecks.filter((check) => check.result !== 'range_unavailable').map((check) => check.code))
    pricingDataComplete = submittedCptCodes.length > 0
      && submittedCptCodes.every((code) => checkedCptCodes.has(code))
      && priceChecks.length > 0
      && priceChecks.every((check) => check.result === 'within_range')
  } else if (procedures.length > 1) {
    findings.push('Multiple procedure codes were found. The total claim amount was not compared with single-code price examples.')
  } else if (procedures.length === 1) {
    const [procedure] = procedures
    const minimum = procedure.cost?.reference_min ?? procedure.cost?.observed_min_allowed
    const maximum = procedure.cost?.reference_max ?? procedure.cost?.observed_max_allowed
    const amount = Number(claim?.amount)
    if (Number.isFinite(minimum) && Number.isFinite(maximum) && Number.isFinite(amount)) {
      const inRange = amount >= minimum && amount <= maximum
      priceChecks.push({ code: procedure.code, amount, minimum, maximum, result: inRange ? 'within_range' : 'outside_range' })
      pricingDataComplete = inRange && !ignoredCodes.length && procedures.length === 1
      if (inRange) {
        findings.push(`The total claim amount is within the available range for the single matched CPT code ${procedure.code}; confirm that it represents only that service.`)
      } else {
        significantVariance = true
        findings.push(`The total claim amount is outside the available range for the single matched CPT code ${procedure.code}; confirm itemization and bundled services.`)
      }
    } else {
      findings.push('The code reference verified the procedure but does not provide a price range.')
    }
  } else {
    findings.push('The code reference does not provide procedure pricing.')
  }

  if (!verifiedCount) {
    referenceGap = true
    findings.push('No submitted codes matched the available online, licensed, or medical_codes.xlsx references. Check the code values and escalate for qualified review.')
  }

  const recommendation = pricingDataComplete && !significantVariance && !referenceGap
    ? 'approve'
    : 'manual_review'
  if (recommendation === 'approve') {
    findings.push('Every submitted CPT line-item price is within the available reference range. Pricing check recommends approval; reviewer must confirm all other claim requirements.')
  } else if (priceChecks.length) {
    findings.push('Pricing data is incomplete or at least one code/price needs review; no approval recommendation was made.')
  }

  return {
    recommendation,
    priority: significantVariance ? 'escalation' : referenceGap ? 'escalation' : 'routine',
    label: recommendation === 'approve'
      ? 'Price check passed — recommend approval after reviewer confirmation'
      : significantVariance
      ? '⚠ Potential significant variance — reviewer assessment required'
      : referenceGap
        ? 'Reference gap — consider escalation to a qualified reviewer'
        : 'No major reference variance found — human decision required',
    findings,
    procedures,
    diagnoses,
    priceChecks,
    disclaimer: result?.disclaimer || 'Reference matches and example prices are assistive only and do not establish medical necessity, coverage, or reimbursement. A qualified reviewer must make the claim decision.',
  }
}