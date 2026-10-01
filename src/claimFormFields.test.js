import { describe, expect, it } from 'vitest'
import { extractedValueOrNA, scannedClaimField } from './claimFormFields'

describe('scanned claim form fields', () => {
  it('fills unmatched scanned fields with N/A', () => {
    expect(extractedValueOrNA('')).toBe('N/A')
    expect(extractedValueOrNA('N/A')).toBe('N/A')
    expect(scannedClaimField('', '')).toBe('N/A')
  })

  it('uses detected values and preserves manually entered values', () => {
    expect(scannedClaimField('', 'Northside Clinic')).toBe('Northside Clinic')
    expect(scannedClaimField('My chosen provider', 'Northside Clinic')).toBe('My chosen provider')
    expect(scannedClaimField('N/A', 'Northside Clinic')).toBe('Northside Clinic')
  })
})