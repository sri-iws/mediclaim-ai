
import { Link } from 'react-router-dom'
import logo from '../assets/mediclaim-logo.svg'

const emptyForm = {
  name: '',
  email: '',
  password: '',
  role: 'reviewer',
}

export function LandingPage({
  mode = 'login',
  setMode = () => {},
  form = emptyForm,
  onChange = () => {},
  status = { type: '', message: '' },
  onLogin = () => {},
  onRegister = () => {},
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

        <Link to="/login" className="nav-button button-link">
          Login
        </Link>
      </header>

      <main>
        <section className="hero container">
          <div className="hero-copy">
            <div className="eyebrow">Healthcare claims intelligence</div>
            <h1>AI-enabled review for faster, safer claims decisions.</h1>
            <p className="hero-text">
              MediClaim AI helps TPAs, insurers, patients, and claims teams review documentation, route
              exceptions, and manage review decisions through a role-based workflow.
            </p>

            <div className="hero-actions">
              <Link to="/login" className="primary-button button-link">
                Go to login
              </Link>
              <Link to="/register" className="secondary-button button-link">
                Create account
              </Link>
            </div>
          </div>

          <div className="hero-visual" aria-label="Claims dashboard preview">
            <div className="dashboard-panel">
              <div className="panel-header">
                <span className="status-dot"></span>
                <span>Claims workflow</span>
              </div>

              <div className="summary-row">
                <div className="summary-card accent">
                  <small>Queue</small>
                  <strong>3,198</strong>
                  <span>Open claims</span>
                </div>
                <div className="summary-card">
                  <small>Approval Rate Signal</small>
                  <strong>87%</strong>
                  <span>High confidence</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="auth-section container">
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
                    value={form.name ?? ''}
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
                  value={form.password ?? ''}
                  onChange={onChange}
                />
              </label>

              {mode === 'register' && (
                <label>
                  Role
                  <select name="role" value={form.role} onChange={onChange}>
                    <option value="reviewer">Claims Reviewer</option>
                    <option value="auditor">Auditor</option>
                    <option value="admin">Administrator</option>
                  </select>
                </label>
              )}

              <button type="submit" className="primary-button auth-submit">
                {mode === 'login' ? 'Login to dashboard' : 'Create account'}
              </button>

              {status.message && (
                <div className={status.type === 'error' ? 'status error' : 'status success'}>
                  {status.message}
                </div>
              )}

              {import.meta.env.DEV && (
                <div className="demo-credentials">
                  <strong>Local development demo credentials</strong>
                  <ul>
                    <li>Admin: admin@mediclaim.ai / admin123</li>
                    <li>Auditor: auditor@mediclaim.ai / auditor123</li>
                    <li>Reviewer: reviewer@mediclaim.ai / reviewer123</li>
                  </ul>
                </div>
              )}
            </form>
          </div>
        </section>

      </main>

      <footer className="site-footer container">
        <div className="brand-wrap">
          <div className="brand-mark" aria-label="MediClaim AI logo">
            <img src={logo} alt="MediClaim AI logo" />
          </div>
          <span className="brand-name">MediClaim AI</span>
        </div>
        <p>AI-enabled claims review platform for healthcare operations.</p>
      </footer>
    </div>
  )
}
