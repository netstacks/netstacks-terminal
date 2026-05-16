import type { FormEvent } from 'react';
import { useState } from 'react';
import { PasswordInput } from '../PasswordInput';
import { useAuth } from '../../hooks/useAuth';
import './LoginScreen.css';

/**
 * Enterprise login screen component.
 * Displays when user is not authenticated in Enterprise mode.
 */
export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, isLoading, error, clearError } = useAuth();

  // Map internal errors to user-friendly messages
  const displayError = (() => {
    if (!error) return null;
    if (error.startsWith('seat_limit_reached:'))
      return 'All license seats are in use. Please try again later or contact your administrator.';
    if (error === 'No refresh token available' || error === 'No token after refresh')
      return 'Invalid credentials. Please check your username and password.';
    return error;
  })();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    try {
      await login(email, password);
      // On success, AuthProvider will show main app
    } catch {
      // Error handled by store, displayed below
    }
  };

  return (
    <div className="login-screen">
      <div className="login-container">
        <div className="login-header">
          <div className="login-logo">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M7 7h.01M7 12h.01M7 17h.01M12 7h5M12 12h5M12 17h5" />
            </svg>
          </div>
          <h1>NetStacks Enterprise</h1>
          <p className="login-subtitle">Sign in to your organization</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {displayError && (
            <div className="login-error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{displayError}</span>
            </div>
          )}
          {displayError?.includes('untrusted TLS certificate') && (
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px', textAlign: 'center' }}>
              Open <strong>Settings → Enterprise</strong> to trust the controller's certificate,
              or check the connection tab in the bottom panel.
            </p>
          )}

          <div className="form-field">
            <label htmlFor="email">Username</label>
            <input
              id="email"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin"
              required
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="form-field">
            <label htmlFor="password">Password</label>
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            className="login-button"
            disabled={isLoading || !email || !password}
          >
            {isLoading ? (
              <span className="login-loading">
                <span className="spinner" />
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        <div className="login-footer">
          <p>Having trouble signing in?</p>
          <p className="login-help">Contact your IT administrator</p>
        </div>
      </div>
    </div>
  );
}

export default LoginScreen;
