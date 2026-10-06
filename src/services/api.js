const API_BASE_URL = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_API_BASE_URL || 'https://mediclaim-ai-1.onrender.com');

function handleUnauthorized() {
  localStorage.removeItem('mediclaim-token')
  localStorage.removeItem('mediclaim-user')
  window.dispatchEvent(new Event('mediclaim:unauthorized'))
}

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const token = localStorage.getItem('mediclaim-token')
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (authenticated && token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new Error('Cannot reach the MediClaim API. Start the backend service and try again.')
  }

  const result = await response.json().catch(() => ({}))
  if (response.status === 401 && authenticated) {
    handleUnauthorized()
    const error = new Error('Your session has expired or is no longer valid. Please sign in again.')
    error.status = 401
    throw error
  }
  if (!response.ok) {
    const error = new Error(result.message || `Request failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  return result
}

export async function loginWithApi(email, password) {
  return request('/auth/login', { method: 'POST', body: { email, password }, authenticated: false })
}

export async function registerWithApi({ name, email, password }) {
  return request('/auth/register', {
    method: 'POST',
    body: { name, email, password },
    authenticated: true,
  })
}

export async function fetchHealth() {
  return request('/health', { authenticated: false })
}

export async function fetchCurrentUser() {
  const { user } = await request('/users/me')
  return user
}

export async function fetchClaim(claimId) {
  const { claim } = await request(`/claims/${encodeURIComponent(claimId)}`)
  return claim
}

export async function deleteAllClaims() {
  return request('/claims', { method: 'DELETE' })
}

export async function fetchPolicy(policyNumber) {
  const { policy } = await request(`/policies/${encodeURIComponent(policyNumber)}`)
  return policy
}

export async function fetchProcedureResults(codes) {
  return request('/procedure-results', { method: 'POST', body: { codes } })
}

export async function fetchClaims() {
  const { claims } = await request('/claims')
  return claims
}

export async function submitClaim(claim) {
  const { claim: created } = await request('/claims', { method: 'POST', body: claim })
  return created
}

export async function deleteClaim(claimId) {
  return request(`/claims/${encodeURIComponent(claimId)}`, { method: 'DELETE' })
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
  if (response.status === 401) {
    handleUnauthorized()
    const error = new Error('Your session has expired or is no longer valid. Please sign in again.')
    error.status = 401
    throw error
  }
  if (!response.ok) {
    const error = new Error(result.message || `Document analysis failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  return result
}

export async function saveClaimReview(claimId, { action, comment = '' }) {
  const { claim } = await request(`/claims/${encodeURIComponent(claimId)}/review`, {
    method: 'PATCH',
    body: { action, comment },
  })
  return claim
}

export async function saveClaimReconciliation(claimId, { reconciled, comment = '' }) {
  const { claim } = await request(`/claims/${encodeURIComponent(claimId)}/reconciliation`, {
    method: 'PATCH',
    body: { reconciled, comment },
  })
  return claim
}

export async function reopenClaimReview(claimId, { comment = '' } = {}) {
  const { claim } = await request(`/claims/${encodeURIComponent(claimId)}/review`, {
    method: 'PATCH',
    body: { action: 'reopen', comment },
  })
  return claim
}

export async function fetchPolicies(query = '') {
  const parameters = new URLSearchParams()
  if (query) parameters.set('q', query)
  const suffix = parameters.size ? `?${parameters.toString()}` : ''
  const { policies } = await request(`/policies${suffix}`)
  return policies
}

export async function fetchUsers() {
  const { users } = await request('/users')
  return users
}

export async function fetchDashboardMetrics() {
  const { metrics } = await request('/dashboard/metrics')
  return metrics
}
