import { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useMode } from '../hooks/useMode';
import { getCertStatus, getCertPublicKey, storeCertificate } from '../api/cert';
import { getClient } from '../api/client';

/**
 * Auto-renews SSH certificates before they expire.
 *
 * Cert renewal requires BOTH enterprise mode (where SSH certs are used)
 * AND a running agent sidecar (for local key storage via /cert/* endpoints).
 *
 * Currently the sidecar exits in enterprise mode, so cert renewal cannot work.
 * Certs are provisioned once during login instead (authStore.login sends
 * public_key to controller, gets signed cert back).
 *
 * TODO: Enable when sidecar stays alive in enterprise mode for cert storage.
 */
export function useCertRenewal(): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const { isEnterprise } = useMode();
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Skip if not authenticated or not enterprise
    if (!isEnterprise || !isAuthenticated) return;

    // Sidecar is not available in enterprise mode — cert renewal disabled.
    // The cert API endpoints (getCertStatus, getCertPublicKey, storeCertificate)
    // go to the agent sidecar which exits when enterprise mode is active.
    // Remove this early return when the sidecar stays alive for cert storage.
    return;

    /* eslint-disable no-unreachable */
    const renewCertificate = async () => {
      try {
        const publicKey = await getCertPublicKey();
        const client = getClient();
        const response = await client.http.post('/ssh-ca/sign-user-auto', {
          public_key: publicKey,
        });
        if (response.data) {
          await storeCertificate(response.data);
          console.log('[useCertRenewal] Certificate renewed successfully');
        }
      } catch (err) {
        console.warn('[useCertRenewal] Renewal failed:', err);
      }
    };

    const checkAndRenew = async () => {
      try {
        const status = await getCertStatus();
        if (!status.valid || !status.expires_at) return;

        const expiresAt = new Date(status.expires_at).getTime();
        const now = Date.now();
        const timeUntilExpiry = expiresAt - now;
        const renewalBuffer = 30 * 60 * 1000; // 30 minutes

        if (timeUntilExpiry <= renewalBuffer) {
          await renewCertificate();
        } else {
          const delay = Math.max(0, timeUntilExpiry - renewalBuffer);
          timerRef.current = window.setTimeout(renewCertificate, delay);
        }
      } catch (err) {
        console.warn('[useCertRenewal] Check failed:', err);
      }
    };

    checkAndRenew();

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    /* eslint-enable no-unreachable */
  }, [isEnterprise, isAuthenticated, accessToken]);
}
