export function cleanClaimField(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return /^(?:n\/?a|not\s+available|unknown|none|null)$/i.test(normalized) ? '' : normalized
}

export function extractedValueOrNA(value) {
  return cleanClaimField(value) || 'N/A'
}

export function scannedClaimField(currentValue, extractedValue) {
  const manualValue = cleanClaimField(currentValue)
  const scannedValue = typeof extractedValue === 'string' ? extractedValue.trim() : ''
  return manualValue || scannedValue || 'N/A'
}