import { describe, expect, it } from 'vitest'
import { parseClaimFields } from './documentScanner'

describe('document field extraction', () => {
  it('uses N/A for missing scalar fields', () => {
    const fields = parseClaimFields('Unrelated document text')

    expect(fields.claimant).toBe('N/A')
    expect(fields.policyNumber).toBe('N/A')
    expect(fields.provider).toBe('N/A')
    expect(fields.amount).toBe('N/A')
    expect(fields.diagnosis).toBe('N/A')
    expect(fields.diagnosisCode).toBe('N/A')
    expect(fields.procedureCode).toBe('N/A')
  })

  it('extracts provider and diagnosis/treatment labels for browser OCR', () => {
    const fields = parseClaimFields(`Attending Physician: Dr. Jamie Lee
Diagnosis / Treatment: Sprained ankle; compression wrap and follow-up`)

    expect(fields.provider).toBe('Dr. Jamie Lee')
    expect(fields.diagnosis).toBe('Sprained ankle; compression wrap and follow-up')
  })

  it('recognizes alternate billing labels and reads next-line values in browser OCR', () => {
    const fields = parseClaimFields(`Beneficiary Full Name = Alex Morgan
Rendering Provider - Northside Medical Center
Description of Services: Emergency evaluation and wound repair
Patient's Name
Jamie Rivera
Facility Name
Central Clinic
Chief Complaint
Persistent cough`)

    expect(fields.claimant).toBe('Alex Morgan')
    expect(fields.provider).toBe('Northside Medical Center')
    expect(fields.diagnosis).toBe('Emergency evaluation and wound repair')
  })

  it('does not treat a recognized field label as the following claimant value', () => {
    const fields = parseClaimFields(`Patient Name
Provider Name: Central Clinic
Diagnosis: Follow-up care`)

    expect(fields.claimant).toBe('N/A')
    expect(fields.provider).toBe('Central Clinic')
    expect(fields.diagnosis).toBe('Follow-up care')
  })

  it('reads values below standalone claimant, provider and diagnosis labels', () => {
    const fields = parseClaimFields(`Beneficiary Name
Jamie Rivera
Facility Name
Central Clinic
Services Rendered
Examination and wound dressing`)

    expect(fields.claimant).toBe('Jamie Rivera')
    expect(fields.provider).toBe('Central Clinic')
    expect(fields.diagnosis).toBe('Examination and wound dressing')
  })

  it('maps provider role and payee labels without treating IDs or charges as a name', () => {
    expect(parseClaimFields('Servicing Provider: Northside Clinic').provider).toBe('Northside Clinic')
    expect(parseClaimFields('Billed By: Central Medical Center').provider).toBe('Central Medical Center')
    expect(parseClaimFields('Vendor Name: Example Health Services').provider).toBe('Example Health Services')
    expect(parseClaimFields('Billing Provider Tax ID: 12-3456789').provider).toBe('N/A')
    expect(parseClaimFields('Provider NPI: 1234567890').provider).toBe('N/A')
    expect(parseClaimFields('Facility Charges: $425.00').provider).toBe('N/A')
    expect(parseClaimFields('Subscriber ID: SUB-00421')).toMatchObject({ claimant: 'N/A', policyNumber: 'SUB-00421' })
  })

  it('parenthesizes bare five-digit codes in the diagnosis summary', () => {
    const fields = parseClaimFields('Diagnosis: Office visit 99213 and follow-up (99214)')

    expect(fields.diagnosis).toBe('Office visit (99213) and follow-up (99214)')
  })

  it('maps account number and the date-of-service section for browser OCR', () => {
    const fields = parseClaimFields(`Patient: Alex Morgan
Account ##: AC-88421
DATE OF SERVICE
2026-09-27 - Office consultation and wound dressing
Follow-up instructions provided
INSURANCE
Plan: Example Health`)

    expect(fields.policyNumber).toBe('AC-88421')
    expect(fields.diagnosis).toBe(
      '2026-09-27 - Office consultation and wound dressing Follow-up instructions provided',
    )
  })

  it('excludes tablet lines from the diagnosis/treatment section', () => {
    const fields = parseClaimFields(`DATE OF SERVICE
Consultation for migraine
Prescribed ExampleMed 10 mg tablets
Rest and hydration recommended
INSURANCE
Plan: Example Health`)

    expect(fields.diagnosis).toBe('Consultation for migraine Rest and hydration recommended')
  })

  it('extracts multiple diagnosis and procedure codes for code verification', () => {
    const fields = parseClaimFields(`ICD-10-CM code: J20.9
  Secondary diagnosis code: E11.9
  CPT code: 99213
  HCPCS code: A0428`)

    expect(fields.diagnosisCodes).toEqual(['J20.9', 'E11.9'])
    expect(fields.procedureCodes).toEqual(['99213', 'A0428'])
    expect(fields.cptCodes).toEqual(['99213'])
    expect(fields.hcpcsCodes).toEqual(['A0428'])
  })

  it('extracts line-item prices beside CPT codes', () => {
    const fields = parseClaimFields('CPT (99213) $125.00\nCPT 99214 - $199.50')

    expect(fields.procedureAmounts).toEqual([
      { code: '99213', amount: 125 },
      { code: '99214', amount: 199.5 },
    ])
  })
})