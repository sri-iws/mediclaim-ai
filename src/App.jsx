import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import './App.css'
import { deleteClaim, fetchClaims, loginWithApi, registerWithApi, reopenClaimReview, saveClaimReview, submitClaim } from './services/api'
import { LandingPage } from './pages/LandingPage'
import { AuthPage } from './pages/AuthPage'
import { DashboardPage } from './pages/DashboardPage'
import { cleanClaimField, scannedClaimField } from './claimFormFields'

const defaultForm = {
  name: '',
  email: '',
  password: '',
}

const defaultClaimForm = {
  claimant: '',
  policyNumber: '',
  provider: '',
  amount: '',
  diagnosis: '',
  documents: '',
  documentAnalysis: null,
}

function readStoredSession() {
  try {
    const token = localStorage.getItem('mediclaim-token')
    const user = JSON.parse(localStorage.getItem('mediclaim-user') || 'null')
    return token && user?.id ? user : null
  } catch {
    return null
  }
}

function getClaimDraftKey(userId) {
  return `mediclaim-claim-draft:${userId}`
}

function readClaimDraft(userId) {
  if (!userId) return defaultClaimForm
  try {
    const savedDraft = JSON.parse(localStorage.getItem(getClaimDraftKey(userId)) || 'null')
    if (!savedDraft || typeof savedDraft !== 'object') return defaultClaimForm
    return {
      ...defaultClaimForm,
      claimant: typeof savedDraft.claimant === 'string' ? savedDraft.claimant : '',
      policyNumber: typeof savedDraft.policyNumber === 'string' ? savedDraft.policyNumber : '',
      provider: typeof savedDraft.provider === 'string' ? savedDraft.provider : '',
      amount: typeof savedDraft.amount === 'string' ? savedDraft.amount : '',
      diagnosis: typeof savedDraft.diagnosis === 'string' ? savedDraft.diagnosis : '',
      documentAnalysis: savedDraft.documentAnalysis && typeof savedDraft.documentAnalysis === 'object'
        ? savedDraft.documentAnalysis
        : null,
    }
  } catch {
    return defaultClaimForm
  }
}

function AppShell() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState(defaultForm)
  const [status, setStatus] = useState({ type: '', message: '' })
  const [session, setSession] = useState(readStoredSession)
  const [claimForm, setClaimForm] = useState(() => readClaimDraft(session?.id))
  const [claimDocumentFiles, setClaimDocumentFiles] = useState([])
  const [claims, setClaims] = useState([])

  useEffect(() => {
    if (!session?.id) return
    try {
      const { claimant, policyNumber, provider, amount, diagnosis, documentAnalysis } = claimForm
      localStorage.setItem(getClaimDraftKey(session.id), JSON.stringify({
        claimant,
        policyNumber,
        provider,
        amount,
        diagnosis,
        documentAnalysis,
      }))
    } catch (error) {
      console.warn('Could not save the claim draft in this browser.', error)
    }
  }, [claimForm, session])

  useEffect(() => {
    if (!session) return undefined

    let isCurrent = true
    fetchClaims()
      .then((loadedClaims) => {
        if (isCurrent) setClaims(loadedClaims)
      })
      .catch((error) => {
        if (isCurrent) setStatus({ type: 'error', message: error.message })
      })

    return () => { isCurrent = false }
  }, [session])

  const handleChange = (event) => {
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
  }

  const handleLogin = async (event) => {
    event.preventDefault()
    try {
      const result = await loginWithApi(form.email, form.password)
      localStorage.setItem('mediclaim-token', result.token)
      localStorage.setItem('mediclaim-user', JSON.stringify(result.user))
      setClaimForm(readClaimDraft(result.user.id))
      setClaimDocumentFiles([])
      setSession(result.user)
      setStatus({ type: 'success', message: result.message })
      setForm(defaultForm)
      navigate('/dashboard')
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    }
  }

  const handleRegister = async (event) => {
    event.preventDefault()
    try {
      const result = await registerWithApi(form)
      localStorage.setItem('mediclaim-token', result.token)
      localStorage.setItem('mediclaim-user', JSON.stringify(result.user))
      setClaimForm(readClaimDraft(result.user.id))
      setClaimDocumentFiles([])
      setSession(result.user)
      setStatus({ type: 'success', message: result.message })
      setForm(defaultForm)
      navigate('/dashboard')
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('mediclaim-user')
    localStorage.removeItem('mediclaim-token')
    setClaims([])
    setClaimForm(defaultClaimForm)
    setClaimDocumentFiles([])
    setSession(null)
    setStatus({ type: '', message: '' })
    navigate('/login')
  }

  const handleClaimChange = (event) => {
    const { name, value, files, type } = event.target
    const selectedFiles = type === 'file' ? Array.from(files || []) : null
    const nextValue = selectedFiles ? selectedFiles.map((file) => file.name).join(', ') : value
    if (selectedFiles) setClaimDocumentFiles(selectedFiles)
    setClaimForm((current) => ({
      ...current,
      [name]: nextValue,
      ...(selectedFiles ? { documentAnalysis: null } : {}),
    }))
  }

  const handleClaimReset = () => {
    setClaimForm(defaultClaimForm)
    setClaimDocumentFiles([])
    setStatus({ type: '', message: '' })
  }

  const handleClaimExtracted = (extracted) => {
    setClaimForm((current) => ({
      ...current,
      documentAnalysis: extracted,
      claimant: scannedClaimField(current.claimant, extracted.claimant),
      policyNumber: scannedClaimField(current.policyNumber, extracted.policyNumber),
      provider: scannedClaimField(current.provider, extracted.provider),
      amount: scannedClaimField(current.amount, extracted.amount),
      diagnosis: scannedClaimField(current.diagnosis, extracted.diagnosis),
    }))

    const filledFields = ['claimant', 'policyNumber', 'provider', 'amount', 'diagnosis']
      .filter((field) => cleanClaimField(extracted[field])).length
    setStatus({
      type: 'success',
      message: filledFields
        ? `Document scan complete. ${filledFields} field${filledFields === 1 ? '' : 's'} extracted from the uploaded document.`
        : 'Document scan complete. No claim fields were confidently identified; using the details entered manually.',
    })
  }

  const handleClaimSubmit = async (event, submittedClaim = claimForm, formElement = event?.currentTarget) => {
    event?.preventDefault()

    try {
      const claim = await submitClaim({
        claimant: submittedClaim.claimant,
        policyNumber: submittedClaim.policyNumber,
        provider: submittedClaim.provider,
        amount: submittedClaim.amount,
        diagnosis: submittedClaim.diagnosis,
        documents: submittedClaim.documents
        ? submittedClaim.documents.split(',').map((item) => item.trim()).filter(Boolean)
        : [],
        documentAnalysis: submittedClaim.documentAnalysis,
      })

      setClaims((currentClaims) => [claim, ...currentClaims.filter((item) => item.id !== claim.id)])
      setStatus({
        type: 'success',
        message: String(claim.status).toLowerCase() === 'rejected'
          ? `${claim.claimant}'s claim was rejected because one or more fields are unavailable.`
          : `${claim.claimant}'s claim was submitted successfully.`,
        claimId: claim.id,
      })
      setClaimForm(defaultClaimForm)
      setClaimDocumentFiles([])
      formElement?.reset()
    } catch (error) {
      setStatus({ type: 'error', message: error.message })
    }
  }

  const handleSaveReview = async (claimId, decision) => {
    const updatedClaim = await saveClaimReview(claimId, decision)
    setClaims((currentClaims) => currentClaims.map((claim) => claim.id === updatedClaim.id ? updatedClaim : claim))
    setStatus({ type: 'success', message: `Final review status saved for ${updatedClaim.id}.` })
    return updatedClaim
  }

  const updateClaimFromWorkflow = (updatedClaim, message) => {
    setClaims((currentClaims) => currentClaims.map((claim) => claim.id === updatedClaim.id ? updatedClaim : claim))
    setStatus({ type: 'success', message })
    return updatedClaim
  }

  const handleReopenClaim = async (claimId, details) => {
    const updatedClaim = await reopenClaimReview(claimId, details)
    return updateClaimFromWorkflow(updatedClaim, `Claim ${updatedClaim.id} has been reopened.`)
  }

  const handleDeleteClaim = async (claimId) => {
    await deleteClaim(claimId)
    setClaims((currentClaims) => currentClaims.filter((claim) => claim.id !== claimId))
    setStatus({ type: 'success', message: `Claim ${claimId} was deleted.` })
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <LandingPage
            mode={mode}
            setMode={setMode}
            form={form}
            onChange={handleChange}
            status={status}
            onLogin={handleLogin}
            onRegister={handleRegister}
          />
        }
      />
      <Route
        path="/login"
        element={
          <AuthPage
            mode={mode}
            setMode={setMode}
            form={form}
            onChange={handleChange}
            status={status}
            onLogin={handleLogin}
            onRegister={handleRegister}
          />
        }
      />
      <Route
        path="/register"
        element={
          <AuthPage
            mode="register"
            setMode={() => setMode('register')}
            form={form}
            onChange={handleChange}
            status={status}
            onLogin={handleLogin}
            onRegister={handleRegister}
          />
        }
      />
      <Route
        path="/dashboard/*"
        element={
          session ? (
            <DashboardPage
              user={session}
              onLogout={handleLogout}
              claimForm={claimForm}
              onClaimChange={handleClaimChange}
              onClaimSubmit={handleClaimSubmit}
              onClaimExtracted={handleClaimExtracted}
              onClaimReset={handleClaimReset}
              claims={claims}
              onSaveReview={handleSaveReview}
              onReopenClaim={handleReopenClaim}
              onDeleteClaim={handleDeleteClaim}
              selectedClaimFiles={claimDocumentFiles}
              status={status}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}

export default App
