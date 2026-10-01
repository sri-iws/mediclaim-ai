const USERS = [
  {
    id: 'user-admin-1',
    name: 'Admin User',
    email: 'admin@mediclaim.ai',
    password: 'admin123',
    role: 'admin',
  },
  {
    id: 'user-auditor-1',
    name: 'Aisha Khan',
    email: 'auditor@mediclaim.ai',
    password: 'auditor123',
    role: 'auditor',
  },
  {
    id: 'user-reviewer-1',
    name: 'Priya Nair',
    email: 'reviewer@mediclaim.ai',
    password: 'reviewer123',
    role: 'reviewer',
  },
]

const ROLE_PERMISSIONS = {
  admin: [
    'claims_review', 'policy_management', 'audit_logs', 'user_management',
    'new_claim', 'claim_verification', 'procedure_results',
  ],
  auditor: ['claims_review', 'audit_logs', 'procedure_results'],
  reviewer: ['claims_review', 'new_claim', 'claim_verification', 'procedure_results'],
}

export function registerUser({ name, email, password, role }) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const normalizedName = String(name || '').trim()
  const selectedRole = role || 'reviewer'

  if (!normalizedName || !normalizedEmail || !String(password || '').trim()) {
    return { success: false, message: 'Please complete all required fields.' }
  }

  const userExists = USERS.some((user) => user.email.toLowerCase() === normalizedEmail)
  if (userExists) {
    return { success: false, message: 'This email is already registered.' }
  }

  const newUser = {
    id: `user-${Date.now()}`,
    name: normalizedName,
    email: normalizedEmail,
    password: String(password).trim(),
    role: selectedRole,
  }

  USERS.push(newUser)

  return { success: true, user: { ...newUser }, message: 'Registration successful.' }
}

export function loginUser(email, password) {
  const user = USERS.find(
    (item) => item.email.toLowerCase() === String(email || '').trim().toLowerCase()
  )

  if (!user) {
    return { success: false, message: 'No account found for this email.' }
  }

  if (user.password !== String(password || '')) {
    return { success: false, message: 'Incorrect password.' }
  }

  return { success: true, user: { ...user }, message: 'Login successful.' }
}

export function hasAccess(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission)
}

export function getRoleLabel(role) {
  const labels = {
    admin: 'Administrator',
    auditor: 'Auditor',
    reviewer: 'Claims Reviewer',
  }

  return labels[role] || 'User'
}
