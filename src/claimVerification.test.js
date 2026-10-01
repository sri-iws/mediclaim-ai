import { describe, expect, it } from 'vitest'
import { assessClaimReference, getClaimVerificationCodes } from './claimVerification'

describe('claim reference verification', () => {
  it('collects detected procedure and diagnosis codes from document analysis', () => {
    const codes = getClaimVerificationCodes({
      documentAnalysis: {
        extracted: { cptCodes: ['99213'], diagnosisCode: 'J20.9' },
      },
    })

    expect(codes).toEqual(['99213', 'J20.9'])
  })

  it('collects HCPCS Level II codes from extracted documents and claim text', () => {
    const codes = getClaimVerificationCodes({
      documentAnalysis: { extracted: { hcpcsCodes: ['A0428'] } },
      diagnosis: 'Transport code {R0070}; ICD-10-CM (E11.9)',
    })

    expect(codes).toEqual(['A0428', 'R0070', 'E11.9'])
  })

  it('escalates a reference gap after a code remains unmatched', () => {
    const assessment = assessClaimReference(
      { documentAnalysis: { extracted: { diagnosisCodes: ['Z99.9'] } } },
      {
        procedures: [],
        diagnoses: [],
        ignored_codes: [{ value: 'Z99.9', system: 'ICD-10-CM', reason: 'No exact match in online or workbook references.' }],
      },
    )

    expect(assessment.label).toBe('Reference gap — consider escalation to a qualified reviewer')
    expect(assessment.priority).toBe('escalation')
    expect(assessment.findings.join(' ')).toContain('medical_codes.xlsx')
  })

  it('includes billed treatment codes and compares their billed prices to references', () => {
    const claim = {
      treatmentItems: [{ code: '99213', name: 'Office visit', billedPrice: 120 }],
    }
    const assessment = assessClaimReference(claim, {
      procedures: [{ code: '99213', description: 'Office visit', cost: { reference_min: 85, reference_max: 150 } }],
      diagnoses: [],
      ignored_codes: [],
    })

    expect(getClaimVerificationCodes(claim)).toEqual(['99213'])
    expect(assessment.priceChecks).toEqual([
      { code: '99213', amount: 120, minimum: 85, maximum: 150, result: 'within_range' },
    ])
    expect(assessment.findings.join(' ')).toContain('billed price for CPT 99213')
  })

  it('extracts valid codes only from parentheses and braces in claim text', () => {
    const codes = getClaimVerificationCodes({
      diagnosis: 'Bronchitis (ICD-10-CM: J20.9); office visit (CPT 99213); other code 99214; invalid (9921X) and {J20.99999}',
    })

    expect(codes).toEqual(['J20.9', '99213'])
  })

  it('filters malformed or unsupported codes from extracted document fields', () => {
    const codes = getClaimVerificationCodes({
      documentAnalysis: {
        extracted: { cptCodes: ['99213', '9921X'], diagnosisCodes: ['J20.9', 'not-a-code'] },
      },
    })

    expect(codes).toEqual(['99213', 'J20.9'])
  })

  it('flags an out-of-range claim amount for manual review without a decision', () => {
    const assessment = assessClaimReference(
      { amount: 250, documentAnalysis: { extracted: { procedureCode: '99213' } } },
      {
        procedures: [{ code: '99213', cost: { reference_min: 85, reference_max: 150 } }],
        diagnoses: [],
        ignored_codes: [],
      },
    )

    expect(assessment.priority).toBe('escalation')
    expect(assessment.label).toContain('reviewer assessment required')
    expect(assessment.findings.join(' ')).toContain('outside the available range')
    expect(assessment).not.toHaveProperty('decision')
  })

  it('does not compare an aggregate amount against a single procedure range', () => {
    const assessment = assessClaimReference(
      { amount: 250, documentAnalysis: { extracted: { cptCodes: ['99213', '99214'] } } },
      {
        procedures: [
          { code: '99213', cost: { reference_min: 85, reference_max: 150 } },
          { code: '99214', cost: { reference_min: 140, reference_max: 220 } },
        ],
        diagnoses: [],
        ignored_codes: [],
      },
    )

    expect(assessment.findings.join(' ')).toContain('Multiple procedure codes')
    expect(assessment.priority).toBe('routine')
  })

  it('compares each extracted CPT price with its matching code range', () => {
    const assessment = assessClaimReference(
      {
        amount: 999,
        documentAnalysis: { extracted: { procedureAmounts: [{ code: '99213', amount: 120 }, { code: '99214', amount: 240 }] } },
      },
      {
        procedures: [
          { code: '99213', cost: { reference_min: 85, reference_max: 150 } },
          { code: '99214', cost: { reference_min: 140, reference_max: 220 } },
        ],
        diagnoses: [],
        ignored_codes: [],
      },
    )

    expect(assessment.priceChecks).toEqual([
      { code: '99213', amount: 120, minimum: 85, maximum: 150, result: 'within_range' },
      { code: '99214', amount: 240, minimum: 140, maximum: 220, result: 'outside_range' },
    ])
    expect(assessment.priority).toBe('escalation')
    expect(assessment.recommendation).toBe('manual_review')
  })

  it('recommends approval when the extracted CPT price is at either inclusive range boundary', () => {
    const assessment = assessClaimReference(
      {
        amount: 999,
        documentAnalysis: { extracted: { procedureAmounts: [{ code: '99213', amount: 85 }, { code: '99214', amount: 220 }] } },
      },
      {
        procedures: [
          { code: '99213', cost: { reference_min: 85, reference_max: 150 } },
          { code: '99214', cost: { reference_min: 140, reference_max: 220 } },
        ],
        diagnoses: [],
        ignored_codes: [],
      },
    )

    expect(assessment.priceChecks.every((check) => check.result === 'within_range')).toBe(true)
    expect(assessment.recommendation).toBe('approve')
    expect(assessment.label).toContain('recommend approval')
    expect(assessment).not.toHaveProperty('decision')
  })

  it('does not recommend approval when one of multiple CPT prices is outside its code range', () => {
    const assessment = assessClaimReference(
      {
        documentAnalysis: { extracted: { procedureAmounts: [{ code: '99213', amount: 120 }, { code: '99214', amount: 240 }] } },
      },
      {
        procedures: [
          { code: '99213', cost: { reference_min: 85, reference_max: 150 } },
          { code: '99214', cost: { reference_min: 140, reference_max: 220 } },
        ],
        diagnoses: [],
        ignored_codes: [],
      },
    )

    expect(assessment.recommendation).toBe('manual_review')
  })

  it('does not recommend approval if a detected CPT code has no matched line-item price', () => {
    const assessment = assessClaimReference(
      {
        documentAnalysis: {
          extracted: {
            cptCodes: ['99213', '99214'],
            procedureAmounts: [{ code: '99213', amount: 120 }],
          },
        },
      },
      {
        procedures: [
          { code: '99213', cost: { reference_min: 85, reference_max: 150 } },
          { code: '99214', cost: { reference_min: 140, reference_max: 220 } },
        ],
        diagnoses: [],
        ignored_codes: [],
      },
    )

    expect(assessment.recommendation).toBe('manual_review')
  })
})