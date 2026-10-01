import logo from '../assets/mediclaim-logo.svg'

export function AuthPage({
  mode,
  setMode,
  form,
  onChange,
  status,
  onLogin,
  onRegister,
}) {
  return (
    <div className="page-shell">
      <header className="topbar container">
        <div className="brand-wrap">
          <div className="brand-mark" aria-label="MediClaim AI logo">
            <img src={logo} alt="MediClaim AI logo" />
          </div>
          <span className="brand-name">MediClaim AI</span>
        </div>

        <button type="button" className="nav-button" onClick={() => window.location.href = '/'}>
          Back to home
        </button>
      </header>

      <main className="auth-section container">
        <div className="auth-panel">
          <div className="auth-header">
            <div>
              <span className="eyebrow">Secure access</span>
              <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
            </div>
            <div className="auth-toggle">
              <button
                type="button"
                className={mode === 'login' ? 'toggle active' : 'toggle'}
                onClick={() => setMode('login')}
              >
                Login
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'toggle active' : 'toggle'}
                onClick={() => setMode('register')}
              >
                Register
              </button>
            </div>
          </div>

          <form onSubmit={mode === 'login' ? onLogin : onRegister} className="auth-form">
            {mode === 'register' && (
              <label>
                Full name
                <input
                  type="text"
                  name="name"
                  placeholder="Enter your full name"
                  value={form.name}
                  onChange={onChange}
                />
              </label>
            )}

            <label>
              Email address
              <input
                type="email"
                name="email"
                placeholder="name@company.com"
                value={form.email}
                onChange={onChange}
              />
            </label>

            <label>
              Password
              <input
                type="password"
                name="password"
                placeholder="Enter password"
                value={form.password}
                onChange={onChange}
              />
            </label>

            {mode === 'register' && <p className="auth-registration-note">New accounts are registered with the Claims Reviewer role.</p>}

            <button type="submit" className="primary-button auth-submit">
              {mode === 'login' ? 'Login to dashboard' : 'Create account'}
            </button>

            {status.message && (
              <div className={status.type === 'error' ? 'status error' : 'status success'}>
                {status.message}
              </div>
            )}
          </form>
        </div>
      </main>
    </div>
  )
}
