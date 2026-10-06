import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import logo from '../assets/mediclaim-logo.svg'
import { getRoleLabel, hasAccess } from '../auth'
import { assessClaimReference, getClaimVerificationCodes } from '../claimVerification'
import { ClaimIntakeForm } from '../components/ClaimIntakeForm'
import { fetchDashboardMetrics, fetchProcedureResults } from '../services/api'

const accessModules = [
  {
    id: 'claims_review',
    title: 'Claims review',
    description: 'Review document intake, coding matches, and exception reports.',
    required: 'reviewer',
  },
  {
    id: 'policy_management',
    title: 'Policy management',
    description: 'Configure coverage rules, exclusions, and reimbursement logic.',
    required: 'admin',
  },
  {
    id: 'audit_logs',
    title: 'Audit logs',
    description: 'Inspect review traceability, approvals, and decision history.',
    required: 'auditor',
  },
]

function getClaimStatusClass(status) {
  const normalizedStatus = String(status || '').toLowerCase()
  if (['accepted', 'approved'].includes(normalizedStatus)) return 'status-accepted'
  if (normalizedStatus === 'rejected') return 'status-rejected'
  if (normalizedStatus === 'escalated') return 'status-escalated'
  if (normalizedStatus === 'reopened') return 'status-reopened'
  return 'status-pending'
}

function getClaimStatusLabel(status) {
  return String(status || 'Submitted').replace(/\b\w/g, (character) => character.toUpperCase())
}

function getClaimSubmissionDate(createdAt) {
  if (!createdAt) return '—'
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

const DASHBOARD_TABS = [
  { id: 'dashboard', label: 'Dashboard', permission: null },
  { id: 'new-claim', label: 'New claim', permission: 'new_claim' },
  { id: 'claim-verification', label: 'Claim verification', permission: 'claim_verification' },
]

function DashboardTopbar({ user, onLogout, activeTab, onNavigate }) {
  const visibleTabs = DASHBOARD_TABS.filter((tab) => !tab.permission || hasAccess(user.role, tab.permission))

  return (
    <header className="topbar container dashboard-topbar">
      <div className="brand-wrap">
        <div className="brand-mark" aria-label="MediClaim AI logo">
          <img src={logo} alt="MediClaim AI logo" />
        </div>
        <span className="brand-name">MediClaim AI</span>
      </div>

      <nav className="dashboard-tabs" aria-label="Dashboard navigation">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'dashboard-tab active' : 'dashboard-tab'}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => onNavigate(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="session-actions">
        <span className="role-pill">{getRoleLabel(user.role)}</span>
        <button type="button" className="secondary-button" onClick={onLogout}>Logout</button>
      </div>
    </header>
  )
}

function getClaimInsights(claim) {
  const documents = claim.documents || []
  const description = claim.summary || claim.diagnosis || ''
  const analysis = claim.documentAnalysis
  const extracted = analysis?.extracted || {}
  const codeChecks = analysis?.codeChecks || {}
  const suppliedIssues = claim.issues || []
  const discrepancies = [...suppliedIssues]
  const humanReview = []
  if (/(duplicate|prior authorization|exceeds|mismatch)/i.test(description) && discrepancies.length === 0) {
    discrepancies.push('Potential billing or policy exception detected from claim summary')
  }

  const policyIsFormatted = /^POL-\d{4,}$/i.test(claim.policyNumber || '')
  const verified = [
    ...(claim.claimant ? [{ label: 'Claimant name provided', result: 'Present' }] : []),
    ...(claim.provider ? [{ label: 'Provider name provided', result: 'Present' }] : []),
    ...(policyIsFormatted ? [{ label: 'Policy number format', result: 'Valid' }] : []),
  ]
  const normalizeValue = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const compareEvidence = (label, submittedValue, evidenceValue, isAmount = false) => {
    if (!submittedValue || !evidenceValue) return
    const valuesMatch = isAmount
      ? Number.isFinite(Number(submittedValue))
        && Number.isFinite(Number(evidenceValue))
        && Math.abs(Number(submittedValue) - Number(evidenceValue)) < 0.01
      : normalizeValue(submittedValue) === normalizeValue(evidenceValue)

    if (valuesMatch) {
      verified.push({ label: `${label} matches document`, result: 'Matched' })
    } else {
      discrepancies.push(`${label} on the claim differs from the uploaded document`)
      humanReview.push(`Confirm ${label.toLowerCase()} against the source document`)
    }
  }

  if (analysis) {
    compareEvidence('Claimant', claim.claimant, extracted.claimant)
    compareEvidence('Provider', claim.provider, extracted.provider)
    compareEvidence('Policy number', claim.policyNumber, extracted.policyNumber)
    compareEvidence('Claim amount', claim.amount, extracted.amount, true)

    const checkedCodes = Object.values(codeChecks).filter(Boolean)
    for (const codeCheck of checkedCodes) {
      const codeDescription = `${codeCheck.system} code ${codeCheck.value}`
      if (codeCheck.formatValid) {
        verified.push({ label: `${codeDescription} syntax`, result: 'Format checked' })
      } else {
        discrepancies.push(`${codeDescription} has an unexpected format`)
        humanReview.push(`Verify ${codeDescription} against the source document`)
      }
    }

    if (!checkedCodes.length) {
      humanReview.push('No diagnosis or procedure code was detected in the uploaded evidence')
    } else {
      humanReview.push('Code syntax was checked only; confirm code validity against the current official code set')
    }
  }

  const missingEvidence = documents.length ? [] : ['No supporting documents attached']
  if (!claim.diagnosis && !claim.summary) {
    missingEvidence.push('Diagnosis or treatment summary not provided')
  }

  const statusNeedsReview = ['submitted', 'reopened', 'pending review', 'escalated'].includes(String(claim.status).toLowerCase())
  if (statusNeedsReview) {
    humanReview.push(`Claim status: ${claim.status || 'Submitted'}`)
  }
  if (discrepancies.some((item) => /(review|confirm|authorization|duplicate|threshold|mismatch)/i.test(item))) {
    humanReview.push('Resolve the flagged discrepancy before a decision')
  }

  return {
    documents,
    verified,
    discrepancies: [...new Set(discrepancies)],
    missingEvidence: [...new Set(missingEvidence)],
    humanReview: [...new Set(humanReview)],
  }
}

function ClaimAuditDialog({ claim, userRole, onClose, onSaveReview, onReopenClaim }) {
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const insights = getClaimInsights(claim)
  const canReview = ['reviewer', 'admin'].includes(userRole)
  const isFinal = ['accepted', 'approved', 'rejected'].includes(String(claim.status).toLowerCase())
  const events = claim.auditTrail?.length ? claim.auditTrail : [{
    type: 'claim_submitted',
    actor: claim.createdBy || 'System',
    at: claim.createdAt,
  }]

  const reopen = async () => {
    setWorkflowBusy(true)
    setError('')
    setSavedMessage('')
    try {
      await onReopenClaim(claim.id, { comment })
      setComment('')
      setSavedMessage('Claim reopened and returned to the review queue.')
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setWorkflowBusy(false)
    }
  }

  const saveDecision = async (action) => {
    setSaving(true)
    setError('')
    setSavedMessage('')
    try {
      await onSaveReview(claim.id, { action, comment })
      setComment('')
      setSavedMessage(action === 'escalate'
        ? 'Escalation saved. The claim remains open for a later final decision.'
        : `Final review status saved as ${action === 'accept' ? 'approved' : 'rejected'}.`)
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="claim-audit-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="claim-audit-dialog" role="dialog" aria-modal="true" aria-labelledby="claim-audit-title">
        <header className="claim-audit-header">
          <div>
            <span className="eyebrow">Claim audit details</span>
            <h2 id="claim-audit-title">{claim.id}</h2>
            <span className={`claim-status ${getClaimStatusClass(claim.status)}`}>{getClaimStatusLabel(claim.status)}</span>
          </div>
          <button type="button" className="claim-audit-close" onClick={onClose} aria-label="Close claim details">×</button>
        </header>

        <div className="claim-audit-content">
          <section className="audit-detail-section">
            <h3>Claim information</h3>
            <dl className="audit-detail-grid">
              <div><dt>Claimant</dt><dd>{claim.claimant || '—'}</dd></div>
              <div><dt>Provider</dt><dd>{claim.provider || '—'}</dd></div>
              <div><dt>Policy</dt><dd>{claim.policyNumber || '—'}</dd></div>
              <div><dt>Claim amount</dt><dd>${Number(claim.amount || 0).toLocaleString()}</dd></div>
              <div><dt>Submitted</dt><dd>{getClaimSubmissionDate(claim.createdAt)}</dd></div>
              <div className="audit-detail-wide"><dt>Diagnosis / treatment</dt><dd>{claim.diagnosis || claim.summary || 'Not provided'}</dd></div>
              {claim.treatmentItems?.length > 0 && <div className="audit-detail-wide"><dt>Billed treatment line items</dt><dd><ul className="audit-treatment-list">{claim.treatmentItems.map((item, index) => <li key={`${item.code}-${index}`}><strong>{item.code}</strong> · {item.name} · ${Number(item.billedPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</li>)}</ul></dd></div>}
            </dl>
          </section>

          <section className="audit-detail-section">
            <h3>Review checks</h3>
            {insights.verified.length > 0 && <div className="audit-check-group"><h4>Verified</h4><ul>{insights.verified.map((item) => <li key={item.label}>{item.label} <span>{item.result}</span></li>)}</ul></div>}
            {insights.discrepancies.length > 0 && <div className="audit-check-group audit-check-warning"><h4>Discrepancies</h4><ul>{insights.discrepancies.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            {insights.missingEvidence.length > 0 && <div className="audit-check-group audit-check-warning"><h4>Missing evidence</h4><ul>{insights.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            {insights.humanReview.length > 0 && <div className="audit-check-group"><h4>Human review notes</h4><ul>{insights.humanReview.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            {insights.documents.length > 0 && <div className="audit-check-group"><h4>Attached documents</h4><ul>{insights.documents.map((document) => <li key={document}>{document}</li>)}</ul></div>}
          </section>

          <section className="audit-detail-section">
            <h3>Audit history</h3>
            <ol className="audit-timeline">
              {events.map((event, index) => (
                <li key={`${event.type || 'event'}-${event.at || index}`}>
                  <strong>{event.type === 'review_decision' ? `Review ${event.action} · ${getClaimStatusLabel(event.toStatus)}` : event.type === 'claim_reopened' ? 'Claim reopened' : event.type === 'evidence_reconciled' ? 'Claim and evidence reconciled' : event.type === 'reconciliation_reopened' ? 'Reconciliation reopened' : event.reason ? 'Claim rejected' : 'Claim submitted'}</strong>
                  <span>{event.actor || 'System'}{event.at ? ` · ${new Date(event.at).toLocaleString()}` : ''}</span>
                  {event.reason && <p>{event.reason}</p>}
                  {event.comment && <p>{event.comment}</p>}
                </li>
              ))}
            </ol>
          </section>

          {canReview && (isFinal ? (
            <section className="audit-final-review">
              <h3>Final review</h3>
              <p className="final-review-saved" role="status">Final review status saved by {claim.reviewDecision?.reviewer || 'a reviewer'}{claim.reviewDecision?.decidedAt ? ` on ${new Date(claim.reviewDecision.decidedAt).toLocaleString()}` : ''}.</p>
              <label htmlFor="reopen-comment">Reopen reason <span>(optional)</span></label>
              <textarea id="reopen-comment" value={comment} onChange={(event) => setComment(event.target.value)} rows="2" placeholder="Why does this claim need another review?" />
              {error && <p className="status error" role="alert">{error}</p>}
              <div className="audit-review-actions">
                <button type="button" className="secondary-button" disabled={workflowBusy || saving} onClick={reopen}>{workflowBusy ? 'Reopening…' : 'Reopen claim'}</button>
              </div>
            </section>
          ) : (
            <section className="audit-final-review">
              <h3>Final review</h3>
              <label htmlFor="review-comment">Decision note <span>(optional)</span></label>
              <textarea id="review-comment" value={comment} onChange={(event) => setComment(event.target.value)} rows="3" placeholder="Add a brief reason for the decision" />
              {savedMessage && <p className="final-review-saved" role="status">{savedMessage}</p>}
              {error && <p className="status error" role="alert">{error}</p>}
              <div className="audit-review-actions">
                <button type="button" className="secondary-button reviewer-accept" disabled={workflowBusy || saving} onClick={() => saveDecision('accept')}>{saving ? 'Saving…' : 'Approve claim'}</button>
                <button type="button" className="secondary-button reviewer-reject" disabled={workflowBusy || saving} onClick={() => saveDecision('reject')}>{saving ? 'Saving…' : 'Reject claim'}</button>
                <button type="button" className="secondary-button" disabled={workflowBusy || saving} onClick={() => saveDecision('escalate')}>{saving ? 'Saving…' : 'Escalate'}</button>
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  )
}

function ClaimIdButton({ claim, onOpenClaim }) {
  return <button type="button" className="claim-open-button" onClick={() => onOpenClaim(claim)} aria-label={`Open audit details for ${claim.id}`}>{claim.id}</button>
}

function SubmittedClaims({ claims = [], onOpenClaim, onDeleteClaim }) {
  const [deletingId, setDeletingId] = useState('')
  const latestClaims = [...claims].sort((left, right) =>
    new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
  )

  const handleDelete = async (claim) => {
    if (!window.confirm(`Delete claim ${claim.id}? This cannot be undone.`)) return
    setDeletingId(claim.id)
    try {
      await onDeleteClaim(claim.id)
    } finally {
      setDeletingId('')
    }
  }

  return (
    <section className="claims-list submitted-claims" id="submitted-claims">
      <div className="claim-form-header">
        <div>
          <span className="eyebrow">Submitted claims</span>
          <h3>Latest submissions</h3>
        </div>
      </div>

      {latestClaims.length === 0 ? (
        <p className="empty-state">No claims have been submitted yet.</p>
      ) : (
        <div className="claims-table-wrap">
          <table className="claims-table" aria-label="Latest submitted claims">
            <thead>
              <tr>
                <th scope="col">Claim ID</th>
                <th scope="col">Claimant</th>
                <th scope="col">Diagnosis / treatment</th>
                <th scope="col">Policy</th>
                <th scope="col">Provider</th>
                <th scope="col">Amount</th>
                <th scope="col">Documents</th>
                <th scope="col">Submitted</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {latestClaims.map((claim) => (
                <tr key={claim.id}>
                  <td className="claim-table-id"><ClaimIdButton claim={claim} onOpenClaim={onOpenClaim} /></td>
                  <td>{claim.claimant}</td>
                  <td className="claim-table-description">{claim.diagnosis}</td>
                  <td>{claim.policyNumber}</td>
                  <td>{claim.provider}</td>
                  <td>${Number(claim.amount).toLocaleString()}</td>
                  <td className="claim-table-documents">{claim.documents?.length ? claim.documents.join(', ') : 'None uploaded'}</td>
                  <td>{getClaimSubmissionDate(claim.createdAt)}</td>
                  <td><span className={`claim-status ${getClaimStatusClass(claim.status)}`}>{getClaimStatusLabel(claim.status)}</span></td>
                  <td>
                    <button
                      type="button"
                      className="secondary-button reviewer-reject claim-delete-button"
                      disabled={deletingId === claim.id}
                      onClick={() => handleDelete(claim)}
                    >
                      {deletingId === claim.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}


function ReviewDecisions({ reviewQueue, onOpenClaim }) {
  const decisions = reviewQueue
    .filter((claim) => claim.reviewDecision)
    .sort((left, right) => new Date(right.reviewDecision.decidedAt) - new Date(left.reviewDecision.decidedAt))

  const counts = {
    accepted: decisions.filter((claim) => claim.reviewDecision.action === 'accept').length,
    rejected: decisions.filter((claim) => claim.reviewDecision.action === 'reject').length,
    escalated: decisions.filter((claim) => claim.reviewDecision.action === 'escalate').length,
    reopened: reviewQueue.filter((claim) => String(claim.status).toLowerCase() === 'reopened').length,
  }

  return (
    <section className="claims-list review-decisions" id="review-decisions">
      <div className="claim-form-header">
        <span className="eyebrow">Decision tracking</span>
        <h3>Reviewer decisions</h3>
      </div>

      <div className="decision-summary">
        <article className="decision-count decision-accepted"><span>Accepted</span><strong>{counts.accepted}</strong></article>
        <article className="decision-count decision-rejected"><span>Rejected</span><strong>{counts.rejected}</strong></article>
        <article className="decision-count decision-escalated"><span>Escalated</span><strong>{counts.escalated}</strong></article>
        <article className="decision-count decision-reopened"><span>Reopened</span><strong>{counts.reopened}</strong></article>
      </div>

      {decisions.length ? (
        <div className="decision-list">
          {decisions.map((claim) => (
            <article className="decision-row" key={claim.id}>
              <div className="decision-case">
                <button type="button" className="decision-claim-link" onClick={() => onOpenClaim(claim)}>{claim.id}</button>
                <span>{claim.claimant} · {claim.provider}</span>
              </div>
              <span className={`decision-badge decision-${claim.reviewDecision.action}`}>
                {claim.reviewDecision.action === 'accept' ? 'Accepted' : claim.reviewDecision.action === 'reject' ? 'Rejected' : 'Escalated'}
              </span>
              <div className="decision-meta">
                <span>By {claim.reviewDecision.reviewer}</span>
                <time dateTime={claim.reviewDecision.decidedAt}>{new Date(claim.reviewDecision.decidedAt).toLocaleString()}</time>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="decision-empty">Reviewer actions will be recorded here as claims are accepted, rejected, or escalated.</p>
      )}
    </section>
  )
}

function ReviewerDashboardPage({ user, onLogout, reviewQueue, claims, onOpenClaim, onSaveReview, onReopenClaim, onDeleteClaim, selectedClaim, onCloseClaim, onNavigateTab }) {
  const pendingCount = reviewQueue.filter((claim) => !['accepted', 'approved', 'rejected'].includes(String(claim.status).toLowerCase())).length
  const escalatedCount = reviewQueue.filter((claim) => String(claim.status).toLowerCase() === 'escalated').length

  return (
    <div className="page-shell dashboard-shell">
      <DashboardTopbar user={user} onLogout={onLogout} activeTab="dashboard" onNavigate={onNavigateTab} />

      <main className="container dashboard-main">
        <section className="dashboard-panel access-panel dashboard-overview reviewer-dashboard-panel">
          <div className="dashboard-header">
            <div>
              <span className="eyebrow">Reviewer workspace</span>
              <h2>{user.name}</h2>
            </div>
            <button type="button" className="primary-button overview-cta" onClick={() => onNavigateTab('new-claim')}>
              + New claim
            </button>
          </div>

          <div className="access-grid">
            <div className="module-card allowed">
              <div className="module-header">
                <h3>Review queue</h3>
                <span className="module-status on">{pendingCount} active</span>
              </div>
              <p>Claims awaiting human review, policy screening, and final approval status.</p>
              <small>Priority queue for claims reviewer triage.</small>
            </div>

            <div className="module-card allowed">
              <div className="module-header">
                <h3>Exception alerts</h3>
                <span className="module-status on">{escalatedCount} escalated</span>
              </div>
              <p>Auto-detected anomalies, duplicate billing, and authorization mismatches.</p>
              <small>Requires specialist attention.</small>
            </div>

            <div className="module-card allowed">
              <div className="module-header">
                <h3>Decision logs</h3>
                <span className="module-status on">{reviewQueue.filter((claim) => claim.reviewDecision).length} recorded</span>
              </div>
              <p>Document and reviewer activity history for audit support and final sign-off.</p>
              <small>Evidence trail available.</small>
            </div>
          </div>

          <ReviewDecisions reviewQueue={reviewQueue} onOpenClaim={onOpenClaim} />
          <SubmittedClaims claims={claims} onOpenClaim={onOpenClaim} onDeleteClaim={onDeleteClaim} />
          {selectedClaim && <ClaimAuditDialog claim={selectedClaim} userRole={user.role} onClose={onCloseClaim} onSaveReview={onSaveReview} onReopenClaim={onReopenClaim} />}
        </section>
      </main>
    </div>
  )
}

function ClaimVerificationPage({ user, onLogout, claims, onSaveReview, onNavigateTab }) {
  const [selectedClaimId, setSelectedClaimId] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [escalating, setEscalating] = useState(false)
  const [escalationMessage, setEscalationMessage] = useState('')
  const requestVersion = useRef(0)
  const selectedClaim = claims.find((claim) => claim.id === selectedClaimId)
  const claimCodes = selectedClaim ? getClaimVerificationCodes(selectedClaim) : []
  const assessment = result && selectedClaim ? assessClaimReference(selectedClaim, result) : null
  const hasReferenceGap = ['reference_gap', 'partial_reference_gap'].includes(result?.reference_status)
  const mayEscalate = ['reviewer', 'admin'].includes(user.role)
    && selectedClaim
    && !['accepted', 'rejected', 'escalated'].includes(String(selectedClaim.status).toLowerCase())

  const handleEscalateReferenceGap = async () => {
    if (!selectedClaim || !onSaveReview) return
    setEscalating(true)
    setEscalationMessage('')
    try {
      const checkedCount = Number(result?.workbook_checked_count || 0)
      const unmatchedCount = Number(result?.ignored_count ?? result?.ignored_codes?.length ?? 0)
      await onSaveReview(selectedClaim.id, {
        action: 'escalate',
        comment: `Reference gap after checking medical_codes.xlsx (${checkedCount} workbook entr${checkedCount === 1 ? 'y' : 'ies'} checked; ${unmatchedCount} code(s) remain unverified). Qualified reviewer follow-up requested.`,
      })
      setEscalationMessage(`Claim ${selectedClaim.id} status updated to escalated for qualified review.`)
    } catch (escalationError) {
      setEscalationMessage(escalationError.message || 'Unable to escalate this claim. Please try again.')
    } finally {
      setEscalating(false)
    }
  }

  const handleVerificationClaimSelect = async (event) => {
    const selectedId = event.target.value
    const requestId = requestVersion.current + 1
    requestVersion.current = requestId
    setSelectedClaimId(selectedId)
    setResult(null)
    setError('')
    setEscalationMessage('')
    setBusy(false)
    const claim = claims.find((item) => item.id === selectedId)
    const codes = claim ? getClaimVerificationCodes(claim) : []
    if (claim && !codes.length) {
      setError('No supported procedure or diagnosis codes were detected for this claim. Review the supporting documentation and add codes before reference checking.')
      return
    }
    if (!claim) return

    setBusy(true)
    try {
      const verification = await fetchProcedureResults(codes.join(', '))
      if (requestVersion.current === requestId) setResult(verification)
    } catch (verificationError) {
      if (requestVersion.current === requestId) setError(verificationError.message)
    } finally {
      if (requestVersion.current === requestId) setBusy(false)
    }
  }

  return (
    <div className="page-shell dashboard-shell">
      <DashboardTopbar user={user} onLogout={onLogout} activeTab="claim-verification" onNavigate={onNavigateTab} />
      <main className="container dashboard-main">
        <section className="dashboard-panel access-panel dashboard-overview procedure-results-page">
          <div className="dashboard-header">
            <div>
              <span className="eyebrow">Claim review support</span>
              <h2>Claim verification</h2>
              <p>Compare detected diagnosis and procedure codes, and CPT minimum and maximum prices, against medical_codes.xlsx. Workbook matches are historical examples, not authoritative coding guidance.</p>
            </div>
          </div>

          <div className="procedure-results-form">
            <label htmlFor="verification-claim">Select a claim</label>
            <select id="verification-claim" value={selectedClaimId} onChange={handleVerificationClaimSelect}>
              <option value="">Choose a submitted claim</option>
              {claims.map((claim) => (
                <option key={claim.id} value={claim.id}>{claim.id} · {claim.claimant} · {claim.status}</option>
              ))}
            </select>
            {selectedClaim && (
              <div className="procedure-verification-summary">
                <strong>{selectedClaim.claimant} · {selectedClaim.provider}</strong>
                <span>Diagnosis / treatment: {selectedClaim.diagnosis || selectedClaim.summary || 'Not provided'}</span>
                <span>Claim amount: ${Number(selectedClaim.amount || 0).toLocaleString()} · Detected code(s): {claimCodes.join(', ') || 'None'}</span>
              </div>
            )}
          </div>

          {busy && <p className="procedure-result-note" role="status">Checking codes and price ranges against medical_codes.xlsx…</p>}
          {error && <p className="status error procedure-results-message" role="alert">{error}</p>}

          {assessment && (
            <section className="procedure-results-results" aria-live="polite">
              <div className="claim-form-header">
                <span className="eyebrow">Reference review signal</span>
                <h3 className={`assessment-label ${assessment.recommendation === 'approve' ? 'assessment-label-success' : ''} ${assessment.label.startsWith('⚠') ? 'assessment-label-danger' : ''}`}>{assessment.label}</h3>
              </div>
              {hasReferenceGap && (
                <div className="audit-check-group audit-check-warning" role="status">
                  <h4>Reference gap — qualified review recommended</h4>
                  <p>{result.ignored_count ?? result.ignored_codes?.length ?? 0} code(s) remain unmatched after {result.workbook_checked_count ?? 0} exact lookup(s) in medical_codes.xlsx. Any unmatched values remain unverified and should be reviewed by a qualified person.</p>
                  {mayEscalate && (
                    <button type="button" className="secondary-button" onClick={handleEscalateReferenceGap} disabled={escalating}>
                      {escalating ? 'Escalating…' : 'Escalate claim for qualified review'}
                    </button>
                  )}
                  {escalationMessage && <p role="status">{escalationMessage}</p>}
                  {String(selectedClaim?.status).toLowerCase() === 'escalated' && <p>This claim is already escalated for qualified review.</p>}
                  {!mayEscalate && String(selectedClaim?.status).toLowerCase() !== 'escalated' && <p>Only an authorized reviewer can update the claim status. Reference verification does not make a coverage or reimbursement decision.</p>}
                </div>
              )}
              <div className="audit-check-group">
                <h4>Findings</h4>
                <ul>{assessment.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
              </div>
              {assessment.priceChecks.length > 0 && (
                <div className="audit-check-group audit-check-warning">
                  <h4>CPT price-to-range decision · {assessment.pricingReferenceStatus === 'verified_authoritative' ? 'versioned reference checked' : assessment.pricingReferenceStatus === 'historical_example' ? 'example reference only' : assessment.pricingReferenceStatus === 'mixed' ? 'mixed reference sources' : 'valid pricing reference unavailable'}</h4>
                  <ul>{assessment.priceChecks.map((check) => (
                    <li key={`${check.code}-${check.amount}`}>
                      <strong>{check.code}</strong> · Extracted amount {Number.isFinite(check.amount) ? `$${check.amount.toLocaleString()}` : 'unavailable'}
                      {Number.isFinite(check.minimum) && Number.isFinite(check.maximum) ? ` · Reference range ${check.currency || 'USD'} ${check.minimum.toLocaleString()}–${check.maximum.toLocaleString()}` : ''}
                      {check.reference && ` · Source: ${check.reference}${check.referenceVersion ? ` (${check.referenceVersion})` : ''}${check.sourceNote ? ` · ${check.sourceNote}` : ''}${check.authoritative ? '' : ' · historical/example only'}`}
                      {check.result === 'within_range' ? ' · Within range' : check.result === 'outside_range' ? ' · Outside range—review required' : ' · Range unavailable'}
                    </li>
                  ))}</ul>
                </div>
              )}
              {assessment.procedures.length > 0 && (
                <div className="audit-check-group">
                  <h4>Procedure reference and example pricing</h4>
                  <ul>{assessment.procedures.map((procedure) => (
                    <li key={procedure.code}>
                      <strong>{procedure.code}</strong> · {procedure.description || 'Procedure description unavailable'}
                      {procedure.cost?.reference_min !== undefined && ` · ${procedure.cost.authoritative ? 'Versioned price range' : 'Historical/example range'} ${procedure.cost.currency || 'USD'} ${procedure.cost.reference_min}–${procedure.cost.reference_max}${procedure.cost.reference ? ` · ${procedure.cost.reference}${procedure.cost.reference_version ? ` (${procedure.cost.reference_version})` : ''}` : ''}`}
                      {procedure.cost?.observed_min_allowed !== undefined && ` · Observed range $${procedure.cost.observed_min_allowed}–$${procedure.cost.observed_max_allowed} ${procedure.cost.currency || 'USD'}`}
                    </li>
                  ))}</ul>
                </div>
              )}
              {assessment.diagnoses.length > 0 && (
                <div className="audit-check-group">
                  <h4>Disease / diagnosis reference</h4>
                  <ul>{assessment.diagnoses.map((diagnosis) => (
                    <li key={diagnosis.code}><strong>{diagnosis.code}</strong> · {diagnosis.description}{diagnosis.common_procedures ? ` · Common procedures listed: ${diagnosis.common_procedures}` : ''}</li>
                  ))}</ul>
                </div>
              )}
              {result?.ignored_codes?.length > 0 && (
                <div className="audit-check-group audit-check-warning">
                  <h4>Unmatched code values</h4>
                  <ul>{result.ignored_codes.map((item, index) => <li key={`${item.value}-${index}`}>{item.system ? `${item.system} ` : ''}{item.value}: {item.reason}</li>)}</ul>
                </div>
              )}
              <p className="procedure-results-disclaimer" role="note">{assessment.disclaimer} Final approve, reject, or escalation actions remain with an authorized human reviewer.</p>
            </section>
          )}
          {!claims.length && <p className="empty-state">No claims are available to verify yet.</p>}
        </section>
      </main>
    </div>
  )
}

export function DashboardPage({ user, onLogout, claimForm, onClaimChange, onClaimSubmit, onClaimExtracted, onClaimReset, claims, onSaveReview, onReopenClaim, onDeleteClaim, selectedClaimFiles = [], status }) {
  const location = useLocation()
  const navigate = useNavigate()
  const userRole = user.role
  const reviewQueue = claims
  const [selectedClaimId, setSelectedClaimId] = useState('')
  const [dashboardMetrics, setDashboardMetrics] = useState(null)
  const normalizedPath = location.pathname.replace(/\/+$/, '')
  const activeTab = normalizedPath.endsWith('/new-claim')
    ? 'new-claim'
    : normalizedPath.endsWith('/claim-verification')
      ? 'claim-verification'
      : 'dashboard'
  const selectedClaim = claims.find((claim) => claim.id === selectedClaimId) || null
  const openClaim = (claim) => setSelectedClaimId(claim.id)
  const closeClaim = () => setSelectedClaimId('')
  const onNavigateTab = (tab) => navigate(tab === 'new-claim'
    ? '/dashboard/new-claim'
    : tab === 'claim-verification'
      ? '/dashboard/claim-verification'
      : '/dashboard')

  useEffect(() => {
    let active = true
    fetchDashboardMetrics()
      .then((metrics) => { if (active) setDashboardMetrics(metrics) })
      .catch(() => { if (active) setDashboardMetrics(null) })
    return () => { active = false }
  }, [claims])

  if (activeTab === 'claim-verification') {
    if (!hasAccess(userRole, 'claim_verification')) return <Navigate to="/dashboard" replace />
    return (
      <ClaimVerificationPage
        user={user}
        onLogout={onLogout}
        claims={claims}
        onSaveReview={onSaveReview}
        onNavigateTab={onNavigateTab}
      />
    )
  }

  if (activeTab === 'new-claim') {
    if (!hasAccess(userRole, 'new_claim')) return <Navigate to="/dashboard" replace />
    return (
      <div className="page-shell dashboard-shell">
        <DashboardTopbar user={user} onLogout={onLogout} activeTab={activeTab} onNavigate={onNavigateTab} />
        <main className="container dashboard-main">
          <section className="dashboard-panel access-panel dashboard-overview create-claim-page">
            <div className="dashboard-header">
              <div>
                <span className="eyebrow">Claim intake</span>
                <h2>Create a new claim</h2>
                <p>Enter the claim information and attach supporting documents for review.</p>
              </div>
            </div>
            {status?.message && (
              <div className={`status ${status.type}${status.claimId ? ' status-submitted' : ''} claim-status-banner`} role="status" aria-live="polite">
                <span>{status.message}</span>
                {status.claimId && <a href="/dashboard#submitted-claims" className="submission-link">View submitted claims</a>}
              </div>
            )}
            <ClaimIntakeForm
              claimForm={claimForm}
              onClaimChange={onClaimChange}
              onClaimSubmit={onClaimSubmit}
              onClaimExtracted={onClaimExtracted}
              onClaimReset={onClaimReset}
              selectedClaimFiles={selectedClaimFiles}
            />
          </section>
        </main>
      </div>
    )
  }

  if (userRole === 'reviewer') {
    return (
      <ReviewerDashboardPage
        user={user}
        onLogout={onLogout}
        reviewQueue={reviewQueue}
        claims={claims}
        onOpenClaim={openClaim}
        onSaveReview={onSaveReview}
        onReopenClaim={onReopenClaim}
        onDeleteClaim={onDeleteClaim}
        selectedClaim={selectedClaim}
        onCloseClaim={closeClaim}
        onNavigateTab={onNavigateTab}
      />
    )
  }

  return (
    <div className="page-shell dashboard-shell">
      <DashboardTopbar user={user} onLogout={onLogout} activeTab={activeTab} onNavigate={onNavigateTab} />

      <main className="container dashboard-main">
        <section className="dashboard-panel access-panel dashboard-overview">
          <div className="dashboard-header">
            <div className="overview-copy">
              <span className="eyebrow">Claims overview</span>
              <h2>Good to see you, {user.name}</h2>
              <p>Track claim progress, review intake checks, and keep supporting evidence close at hand.</p>
            </div>
            {hasAccess(userRole, 'new_claim') && (
              <button type="button" className="primary-button overview-cta" onClick={() => onNavigateTab('new-claim')}>
                + New claim
              </button>
            )}
          </div>

          <div className="overview-metrics">
            <article className="overview-metric">
              <span>Total claims</span>
              <strong>{dashboardMetrics?.totalClaims ?? claims.length}</strong>
              <small>All submitted claims</small>
            </article>
            <article className="overview-metric">
              <span>In review</span>
              <strong>{dashboardMetrics?.inReview ?? claims.filter((claim) => ['submitted', 'reopened', 'pending review', 'escalated'].includes(String(claim.status).toLowerCase())).length}</strong>
              <small>Awaiting a decision</small>
            </article>
            <article className="overview-metric attention-metric">
              <span>Items to check</span>
              <strong>{dashboardMetrics?.itemsToCheck ?? claims.filter((claim) => getClaimInsights(claim).discrepancies.length).length}</strong>
              <small>Potential discrepancies flagged</small>
            </article>
            <article className="overview-metric">
              <span>Evidence files</span>
              <strong>{dashboardMetrics?.evidenceFiles ?? claims.reduce((total, claim) => total + (claim.documents?.length || 0), 0)}</strong>
              <small>Across your claims</small>
            </article>
          </div>

          <section className="claim-workflow" aria-labelledby="claim-workflow-title">
            <div className="claim-form-header">
              <span className="eyebrow">Claim journey</span>
              <h3 id="claim-workflow-title">How a claim moves through review</h3>
            </div>
            <div className="claim-workflow-steps">
              <article className="claim-workflow-step">
                <span className="claim-workflow-number">01</span>
                <div><h4>Intake</h4><p>Enter claim details or attach documents.</p></div>
              </article>
              <article className="claim-workflow-step">
                <span className="claim-workflow-number">02</span>
                <div><h4>Scan</h4><p>Extract diagnosis, medical procedure and drug codes from the documents.</p></div>
              </article>
              <article className="claim-workflow-step">
                <span className="claim-workflow-number">03</span>
                <div><h4>Verify</h4><p>Check claim data, codes, and pricing against reference ranges.</p></div>
              </article>
              <article className="claim-workflow-step">
                <span className="claim-workflow-number">04</span>
                <div><h4>Review</h4><p>A qualified reviewer checks flagged items.</p></div>
              </article>
              <article className="claim-workflow-step">
                <span className="claim-workflow-number">05</span>
                <div><h4>Decision</h4><p>Approve, reject, or escalate the claim for final billing to end users.</p></div>
              </article>
            </div>
          </section>

          <div className="access-section">
            <div className="claim-form-header">
              <span className="eyebrow">Workspace access</span>
              <h3>Tools for your role</h3>
            </div>
            <div className="access-grid">
              {accessModules.map((module) => {
                const allowed = hasAccess(userRole, module.id)
                return (
                  <div key={module.id} className={allowed ? 'module-card allowed' : 'module-card blocked'}>
                    <div className="module-header">
                      <h3>{module.title}</h3>
                      <span className={allowed ? 'module-status on' : 'module-status off'}>{allowed ? 'Access granted' : 'Restricted'}</span>
                    </div>
                    <p>{module.description}</p>
                  </div>
                )
              })}
            </div>
          </div>

          <SubmittedClaims claims={claims} onOpenClaim={openClaim} onDeleteClaim={onDeleteClaim} />
          {selectedClaim && <ClaimAuditDialog claim={selectedClaim} userRole={userRole} onClose={closeClaim} onSaveReview={onSaveReview} onReopenClaim={onReopenClaim} />}
        </section>
      </main>
    </div>
  )
}
