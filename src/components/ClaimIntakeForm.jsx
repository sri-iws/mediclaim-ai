import { useState } from 'react'
import { analyzeClaimDocument } from '../services/api'
import { cleanClaimField, extractedValueOrNA } from '../claimFormFields'

export function ClaimIntakeForm({
  claimForm,
  onClaimChange,
  onClaimSubmit,
  onClaimExtracted,
  onClaimReset,
  selectedClaimFiles = [],
}) {
  const [isScanning, setIsScanning] = useState(false)
  const [scannedFiles, setScannedFiles] = useState(null)
  const [failedFiles, setFailedFiles] = useState(null)
  const [scanProgress, setScanProgress] = useState(null)
  const needsDocumentScan = selectedClaimFiles.length > 0
    && scannedFiles !== selectedClaimFiles
    && failedFiles !== selectedClaimFiles

  const scanDocuments = async ({ fallbackToManual = false } = {}) => {
    if (!selectedClaimFiles.length) return null
    setIsScanning(true)
    setScanProgress({ stage: 'Sending documents for analysis', progress: 0 })
    try {
      const documentResults = []
      let extracted
      try {
        for (let index = 0; index < selectedClaimFiles.length; index += 1) {
          const file = selectedClaimFiles[index]
          setScanProgress({
            stage: `Analyzing document ${index + 1} of ${selectedClaimFiles.length}: ${file.name}`,
            progress: index / selectedClaimFiles.length,
          })
          documentResults.push(await analyzeClaimDocument(file, claimForm))
        }

        const fieldResults = documentResults.map((result) => {
          const fields = result.extracted_fields || {}
          const formFields = result.form_fields || {}
          return {
            ...fields,
            claimant: cleanClaimField(fields.claimant) || cleanClaimField(formFields.claimant),
            policy_number: cleanClaimField(fields.policy_number) || cleanClaimField(formFields.policyNumber),
            provider: cleanClaimField(fields.provider) || cleanClaimField(formFields.provider),
            amount: cleanClaimField(fields.amount) || cleanClaimField(formFields.amount),
            diagnosis: cleanClaimField(fields.diagnosis) || cleanClaimField(formFields.diagnosis),
          }
        })
        const firstValue = (fieldName) => fieldResults.map((fields) => cleanClaimField(fields[fieldName])).find(Boolean) || ''
        const firstClaimValue = (fieldName) => firstValue(fieldName) || 'N/A'
        const firstList = (fieldName) => [...new Set(fieldResults.flatMap((fields) => fields[fieldName] || []))]
        const procedureAmounts = [...new Map(fieldResults
          .flatMap((fields) => fields.procedure_amounts || [])
          .map((item) => [`${item.code}:${item.amount}`, { code: item.code, amount: Number(item.amount) }])).values()]
        const codeChecks = Object.fromEntries(Object.entries(fieldResults
          .map((fields) => fields.code_checks || {})
          .reduce((combined, checks) => ({ ...combined, ...checks }), {}))
          .map(([field, check]) => [field, check ? { ...check, formatValid: check.format_valid } : null]))
        extracted = {
          claimant: firstClaimValue('claimant'),
          policyNumber: firstClaimValue('policy_number'),
          provider: firstClaimValue('provider'),
          amount: firstClaimValue('amount'),
          diagnosis: firstClaimValue('diagnosis'),
          diagnosisCode: firstValue('diagnosis_code'),
          diagnosisCodes: firstList('diagnosis_codes'),
          procedureCode: firstValue('procedure_code'),
          procedureCodes: firstList('procedure_codes'),
          cptCodes: firstList('cpt_codes'),
          hcpcsCodes: firstList('hcpcs_codes'),
          procedureAmounts,
          codeChecks,
          extracted: {
            claimant: firstClaimValue('claimant'),
            policyNumber: firstClaimValue('policy_number'),
            provider: firstClaimValue('provider'),
            amount: firstClaimValue('amount'),
            diagnosis: firstClaimValue('diagnosis'),
            diagnosisCode: firstValue('diagnosis_code'),
            diagnosisCodes: firstList('diagnosis_codes'),
            procedureCode: firstValue('procedure_code'),
            procedureCodes: firstList('procedure_codes'),
            cptCodes: firstList('cpt_codes'),
            hcpcsCodes: firstList('hcpcs_codes'),
            procedureAmounts,
          },
          extractedFields: {
            policyNumbers: firstList('policy_numbers'),
            dates: firstList('dates'),
            amounts: firstList('amounts'),
          },
          findings: documentResults.flatMap((result) => result.analysis?.findings || []),
          analyzedDocuments: documentResults.map((result) => result.filename),
          analysisSource: 'python',
        }
      } catch (analysisError) {
        if (analysisError.status !== undefined && ![404, 502, 503].includes(analysisError.status)) {
          throw analysisError
        }

        setScanProgress({ stage: 'AI analysis endpoint is unavailable; using browser OCR instead', progress: 0 })
        const { scanClaimDocuments } = await import('../documentScanner')
        const browserFields = await scanClaimDocuments(selectedClaimFiles, setScanProgress)
        extracted = {
          ...browserFields,
          claimant: extractedValueOrNA(browserFields.claimant),
          policyNumber: extractedValueOrNA(browserFields.policyNumber),
          provider: extractedValueOrNA(browserFields.provider),
          amount: extractedValueOrNA(browserFields.amount),
          diagnosis: extractedValueOrNA(browserFields.diagnosis),
          extracted: {
            claimant: extractedValueOrNA(browserFields.claimant),
            policyNumber: extractedValueOrNA(browserFields.policyNumber),
            provider: extractedValueOrNA(browserFields.provider),
            amount: extractedValueOrNA(browserFields.amount),
            diagnosis: extractedValueOrNA(browserFields.diagnosis),
            diagnosisCode: browserFields.diagnosisCode,
            diagnosisCodes: browserFields.diagnosisCodes || (browserFields.diagnosisCode ? [browserFields.diagnosisCode] : []),
            procedureCode: browserFields.procedureCode,
            procedureCodes: browserFields.procedureCodes || (browserFields.procedureCode ? [browserFields.procedureCode] : []),
            cptCodes: browserFields.cptCodes || [],
            hcpcsCodes: browserFields.hcpcsCodes || [],
            procedureAmounts: browserFields.procedureAmounts || [],
          },
          extractedFields: {
            policyNumbers: browserFields.policyNumber ? [browserFields.policyNumber] : [],
            dates: [],
            amounts: browserFields.amount ? [Number(browserFields.amount)] : [],
          },
          findings: [],
          analyzedDocuments: selectedClaimFiles.map((file) => file.name),
          analysisSource: 'browser-fallback',
          analysisWarning: analysisError.message,
        }
      }
      onClaimExtracted(extracted)
      const claimWithExtractedDetails = {
        ...claimForm,
        documentAnalysis: extracted,
        claimant: cleanClaimField(claimForm.claimant) || extractedValueOrNA(extracted.claimant),
        policyNumber: cleanClaimField(claimForm.policyNumber) || extractedValueOrNA(extracted.policyNumber),
        provider: cleanClaimField(claimForm.provider) || extractedValueOrNA(extracted.provider),
        amount: cleanClaimField(claimForm.amount) || extractedValueOrNA(extracted.amount),
        diagnosis: cleanClaimField(claimForm.diagnosis) || extractedValueOrNA(extracted.diagnosis),
      }
      setScannedFiles(selectedClaimFiles)
      setFailedFiles(null)
      const fieldsFound = ['claimant', 'policyNumber', 'provider', 'amount', 'diagnosis']
        .filter((field) => cleanClaimField(extracted[field])).length
      setScanProgress({
        stage: extracted.analysisSource === 'browser-fallback'
          ? `Browser OCR fallback complete: ${fieldsFound} field${fieldsFound === 1 ? '' : 's'} found (AI endpoint unavailable).`
          : `Scan complete: ${fieldsFound} field${fieldsFound === 1 ? '' : 's'} found.`,
        progress: 1,
      })
      return claimWithExtractedDetails
    } catch (error) {
      setFailedFiles(selectedClaimFiles)
      setScanProgress({
        stage: `${error.message || 'Document scan failed.'}${fallbackToManual ? ' Creating claim with the details entered manually.' : ''}`,
        error: true,
      })
      return fallbackToManual ? claimForm : null
    } finally {
      setIsScanning(false)
    }
  }

  const handleScanClick = async () => {
    await scanDocuments()
  }

  const handleDocumentChange = (event) => {
    onClaimChange(event)
    setScannedFiles(null)
    setFailedFiles(null)
    setScanProgress(null)
  }

  const handleReset = (event) => {
    event.currentTarget.form?.reset()
    onClaimReset()
    setScannedFiles(null)
    setFailedFiles(null)
    setScanProgress(null)
  }

  const handleSubmit = async (event) => {
    const formElement = event.currentTarget
    event.preventDefault()

    if (!needsDocumentScan) {
      onClaimSubmit(event, claimForm, formElement)
      return
    }

    const claimToCreate = await scanDocuments({ fallbackToManual: true })
    onClaimSubmit(null, claimToCreate || claimForm, formElement)
  }

  return (
    <form id="claim-intake" className="claim-form" onSubmit={handleSubmit}>
      <div className="claim-form-header">
        <span className="eyebrow">Claim intake</span>
        <h3>Create a new claim</h3>
      </div>

      <p className="claim-intake-help">
        Enter claim details yourself, or scan bills and reports. The scanner recognizes common variations of claimant, provider, and diagnosis or service labels, then fills only blank fields; review all extracted text. Your text fields and analysis save in this browser; reselect files after refreshing. Submitted claims appear under Latest submissions.
      </p>

      <div className="claim-grid">
        <label>
          Claimant name
          <input type="text" name="claimant" value={claimForm.claimant} onChange={onClaimChange} placeholder="Enter claimant name" />
        </label>

        <label>
          Policy number <span className="optional-field-label">(optional)</span>
          <input type="text" name="policyNumber" value={claimForm.policyNumber} onChange={onClaimChange} placeholder="Enter policy number" />
        </label>

        <label>
          Provider name
          <input type="text" name="provider" value={claimForm.provider} onChange={onClaimChange} placeholder="Hospital or clinic name" />
        </label>

        <label>
          Claim amount
          <input type="text" inputMode="decimal" name="amount" value={claimForm.amount} onChange={onClaimChange} placeholder="0.00" />
        </label>

        <label className="full-width">
          Diagnosis / treatment summary
          <textarea name="diagnosis" value={claimForm.diagnosis} onChange={onClaimChange} placeholder="Describe diagnosis and treatment details" />
        </label>

        <div className="full-width upload-field">
          <span className="upload-label">Upload medical and billing documents</span>
          <label className="document-upload" htmlFor="claim-documents">
            <span className="upload-icon" aria-hidden="true">↑</span>
            <span className="upload-copy">
              <strong>Select supporting files</strong>
              <small>Invoices, medical reports, prescriptions, or discharge summaries</small>
            </span>
            <span className="upload-action">Browse files</span>
            <input
              id="claim-documents"
              type="file"
              name="documents"
              accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.rtf,.docx,.xlsx,.xlsm"
              multiple
              onChange={handleDocumentChange}
            />
          </label>
          <small className="upload-hint">PDF, images, Word, Excel, CSV, and text files · You can select multiple files</small>
          {claimForm.documents && (
            <div className="selected-documents" aria-live="polite">
              <strong>Selected files</strong>
              <ul>
                {claimForm.documents.split(',').filter(Boolean).map((document) => (
                  <li key={document}><span className="document-icon">FILE</span>{document.trim()}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {scanProgress && (
        <div className={`scan-feedback${scanProgress.error ? ' scan-error' : ''}`} role="status" aria-live="polite">
          <span>{scanProgress.stage}</span>
          {isScanning && typeof scanProgress.progress === 'number' && (
            <progress max="1" value={scanProgress.progress} aria-label="Document scan progress" />
          )}
        </div>
      )}

      <div className="claim-form-actions">
        <button
          type="button"
          className="secondary-button scan-button"
          onClick={handleScanClick}
          disabled={!selectedClaimFiles.length || isScanning}
        >
          {isScanning ? 'Scanning documents…' : scannedFiles === selectedClaimFiles ? 'Scan again' : 'Scan documents'}
        </button>
        <button type="button" className="secondary-button reset-button" onClick={handleReset} disabled={isScanning}>
          Reset form
        </button>
        <button type="submit" className="primary-button auth-submit" disabled={isScanning}>
          {isScanning ? 'Scanning documents…' : 'Create claim'}
        </button>
      </div>
      {selectedClaimFiles.length > 0 && <p className="scan-privacy-note">Documents are sent to the authenticated AI analysis service. Extracted values fill blank fields; verify all OCR results before creating the claim.</p>}
    </form>
  )
}
