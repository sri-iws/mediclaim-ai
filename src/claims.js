const CLAIMS = []
const BARE_FIVE_DIGIT_CODE = /(?<![\d()])(\d{5})(?![\d()])/g

export function normalizeFiveDigitCodes(value) {
  return String(value || '').replace(BARE_FIVE_DIGIT_CODE, '($1)')
}

export function createClaim({ claimant, policyNumber, provider, amount, diagnosis, documents = [], documentAnalysis = null }) {
  const missingFields = [
    ['claimant', claimant],
    ['policy number', policyNumber],
    ['provider', provider],
    ['diagnosis or treatment summary', diagnosis],
  ].filter(([, value]) => !String(value || '').trim()).map(([label]) => label)

  if (missingFields.length) {
    return {
      success: false,
      message: `Please provide the ${missingFields.join(', ')}. Enter them manually or upload a clearer document and try again.`,
    }
  }

  const hasMissingProviderOrPolicy = [provider, policyNumber]
    .some((value) => String(value || '').trim().toUpperCase() === 'N/A')
  const claim = {
    id: `claim-${Date.now()}`,
    claimant: String(claimant).trim(),
    policyNumber: String(policyNumber).trim(),
    provider: String(provider).trim(),
    amount: Number(amount) || 0,
    diagnosis: normalizeFiveDigitCodes(String(diagnosis).trim()),
    documents: documents.map((doc) => String(doc).trim()).filter(Boolean),
    documentAnalysis: documentAnalysis
      ? {
          extracted: {
            claimant: documentAnalysis.claimant,
            provider: documentAnalysis.provider,
            policyNumber: documentAnalysis.policyNumber,
            diagnosis: documentAnalysis.diagnosis,
            amount: documentAnalysis.amount,
            diagnosisCode: documentAnalysis.diagnosisCode,
            diagnosisCodes: documentAnalysis.diagnosisCodes || (documentAnalysis.diagnosisCode ? [documentAnalysis.diagnosisCode] : []),
            procedureCode: documentAnalysis.procedureCode,
            procedureCodes: documentAnalysis.procedureCodes || (documentAnalysis.procedureCode ? [documentAnalysis.procedureCode] : []),
            cptCodes: documentAnalysis.cptCodes || [],
            procedureAmounts: documentAnalysis.procedureAmounts || [],
          },
          codeChecks: { ...(documentAnalysis.codeChecks || {}) },
        }
      : null,
    status: hasMissingProviderOrPolicy ? 'rejected' : 'submitted',
    createdAt: new Date().toISOString(),
  }

  CLAIMS.push(claim)

  return { success: true, claim, message: 'Claim created successfully.' }
}

export function listClaims() {
  return [...CLAIMS]
}
