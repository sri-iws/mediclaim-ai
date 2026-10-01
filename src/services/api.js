const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const token = localStorage.getItem('mediclaim-token')
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (authenticated && token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new Error('Cannot reach the MediClaim API. Start the backend service and try again.')
  }

  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.message || `Request failed (${response.status}).`)
  return result
}

export async function loginWithApi(email, password) {
  return request('/api/auth/login', { method: 'POST', body: { email, password }, authenticated: false })
}

export async function registerWithApi({ name, email, password }) {
  return request('/api/auth/register', {
    method: 'POST',
    body: { name, email, password },
    authenticated: false,
  })
}

export async function fetchClaims() {
  const { claims } = await request('/api/claims')
  return claims
}

export async function submitClaim(claim) {
  const { claim: created } = await request('/api/claims', { method: 'POST', body: claim })
  return created
}

export async function deleteClaim(claimId) {
  return request(`/api/claims/${encodeURIComponent(claimId)}`, { method: 'DELETE' })
}

export async function analyzeClaimDocument(file, claimFields = {}) {
  const token = localStorage.getItem('mediclaim-token')
  const parameters = new URLSearchParams({
    filename: file.name,
    fields: JSON.stringify({
      claimant: claimFields.claimant || '',
      policy_number: claimFields.policyNumber || '',
      provider: claimFields.provider || '',
      diagnosis: claimFields.diagnosis || '',
      amount: claimFields.amount || '',
    }),
  })

  let response
  try {
    response = await fetch(`${API_BASE_URL}/api/documents/analyze?${parameters}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        'X-Upload-Content-Type': file.type || 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    })
  } catch {
    throw new Error('Cannot reach the MediClaim API. Start the backend service and try again.')
  }

  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result.message || `Document analysis failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  return result
}

export async function fetchProcedureResults(codes) {
  return request('/api/procedure-results', {
    method: 'POST',
    body: { codes },
  })
}

export async function saveClaimReview(claimId, { action, comment = '' }) {
  const { claim } = await request(`/api/claims/${encodeURIComponent(claimId)}/review`, {
    method: 'PATCH',
    body: { action, comment },
  })
  return claim
}

export async function saveClaimReconciliation(claimId, { reconciled, comment = '' }) {
  const { claim } = await request(`/api/claims/${encodeURIComponent(claimId)}/reconciliation`, {
    method: 'PATCH',
    body: { reconciled, comment },
  })
  return claim
}

export async function reopenClaimReview(claimId, { comment = '' } = {}) {
  const { claim } = await request(`/api/claims/${encodeURIComponent(claimId)}/review`, {
    method: 'PATCH',
    body: { action: 'reopen', comment },
  })
  return claim
}

export async function fetchPolicies(query = '') {
  const parameters = new URLSearchParams()
  if (query) parameters.set('q', query)
  const suffix = parameters.size ? `?${parameters.toString()}` : ''
  const { policies } = await request(`/api/policies${suffix}`)
  return policies
}

export async function fetchUsers() {
  const { users } = await request('/api/users')
  return users
}

export async function fetchDashboardMetrics() {
  const { metrics } = await request('/api/dashboard/metrics')
  return metrics
}
