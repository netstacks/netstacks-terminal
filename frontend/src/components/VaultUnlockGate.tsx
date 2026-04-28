import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { getVaultStatus, setMasterPassword, unlockVault } from '../api/sessions';
import { useMode } from '../hooks/useMode';
import './VaultUnlockGate.css';

interface VaultUnlockGateProps {
  children: ReactNode;
}

type GateState = 'loading' | 'setup' | 'unlock' | 'unlocked';

/**
 * Gate component that requires vault to be unlocked before showing the app.
 * Similar to SecureCRT's master password prompt on startup.
 */
export default function VaultUnlockGate({ children }: VaultUnlockGateProps) {
  const { isEnterprise } = useMode();
  const [state, setState] = useState<GateState>('loading');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const checkVaultStatus = useCallback(async () => {
    try {
      console.log('Checking vault status...');
      const status = await getVaultStatus();
      console.log('Vault status:', status);
      if (status.unlocked) {
        setState('unlocked');
      } else if (!status.has_master_password) {
        setState('setup');
      } else {
        setState('unlock');
      }
    } catch (err) {
      console.error('Failed to check vault status:', err);
      // Show error and allow retry instead of assuming unlock
      setError('Cannot connect to backend. Please ensure the app is running correctly.');
      setState('unlock');
    }
  }, []);

  useEffect(() => {
    // Only check vault status in Personal mode
    if (!isEnterprise) {
      checkVaultStatus();
    }
  }, [checkVaultStatus, isEnterprise]);

  // In Enterprise mode, vault is managed by Controller - skip local vault gate
  if (isEnterprise) {
    return <>{children}</>;
  }

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Backend enforces a 12-character minimum (AUDIT FIX CRYPTO-009).
    if (password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      // Re-check vault status to prevent creating duplicate passwords
      const currentStatus = await getVaultStatus();
      if (currentStatus.has_master_password) {
        // Password already exists - switch to unlock mode
        setState('unlock');
        setError('A master password already exists. Please unlock instead.');
        setPassword('');
        setConfirmPassword('');
        setLoading(false);
        return;
      }

      await setMasterPassword(password);
      await unlockVault(password);
      setState('unlocked');
    } catch (err) {
      // Check if the error is because password already exists
      const errorMsg = err instanceof Error ? err.message : 'Failed to set master password';
      if (errorMsg.includes('already')) {
        setState('unlock');
        setError('A master password already exists. Please unlock instead.');
        setPassword('');
        setConfirmPassword('');
      } else {
        setError(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError('Please enter your master password');
      return;
    }

    setLoading(true);
    try {
      await unlockVault(password);
      setState('unlocked');
    } catch (err) {
      // Re-check vault status - maybe no password is set
      try {
        const status = await getVaultStatus();
        if (!status.has_master_password) {
          setState('setup');
          setError(null);
          return;
        }
      } catch {
        // Ignore re-check errors
      }
      setError('Invalid password');
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  // Show loading state
  if (state === 'loading') {
    return (
      <div className="vault-gate">
        <div className="vault-gate-container">
          <div className="vault-gate-loading">
            <div className="vault-spinner" />
            <span>Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  // Show main app when unlocked
  if (state === 'unlocked') {
    return <>{children}</>;
  }

  // Show setup or unlock form
  return (
    <div className="vault-gate">
      <div className="vault-gate-container">
        <div className="vault-gate-header">
          <div className="vault-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              <circle cx="12" cy="16" r="1" />
            </svg>
          </div>
          <h1>NetStacks</h1>
          <p className="vault-subtitle">
            {state === 'setup'
              ? 'Create a master password to protect your credentials'
              : 'Enter your master password to unlock'}
          </p>
        </div>

        {error && (
          <div className="vault-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={state === 'setup' ? handleSetup : handleUnlock} className="vault-form">
          <div className="vault-field">
            <label htmlFor="vault-password">
              {state === 'setup' ? 'Master Password' : 'Password'}
            </label>
            <input
              id="vault-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={state === 'setup' ? 'Create a strong password' : 'Enter your password'}
              autoFocus
              disabled={loading}
            />
          </div>

          {state === 'setup' && (
            <div className="vault-field">
              <label htmlFor="vault-confirm">Confirm Password</label>
              <input
                id="vault-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                disabled={loading}
              />
            </div>
          )}

          <button type="submit" className="vault-submit" disabled={loading}>
            {loading ? (
              <>
                <div className="vault-spinner small" />
                <span>{state === 'setup' ? 'Setting up...' : 'Unlocking...'}</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  {state === 'setup' ? (
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  ) : (
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                  )}
                </svg>
                <span>{state === 'setup' ? 'Create Vault' : 'Unlock'}</span>
              </>
            )}
          </button>
        </form>

        {state === 'setup' && (
          <p className="vault-hint">
            This password encrypts all stored credentials. Choose something memorable but secure.
          </p>
        )}

        {state === 'unlock' && (
          <p className="vault-hint">
            Enter your master password to access stored credentials.
          </p>
        )}
      </div>
    </div>
  );
}
