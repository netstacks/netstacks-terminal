// Host-key fingerprint approval API (AUDIT FIX REMOTE-001).
//
// The backend's SSH connect path now blocks on a UI prompt when it sees
// an unknown or changed host key. The frontend polls this surface while a
// connection is in flight and shows a modal so the user can compare the
// fingerprint against an out-of-band source (the device's `show ssh server
// host-key` output, the inventory record, etc.) before accepting.

import { getClient } from './client';

export interface HostKeyPrompt {
  /** UUID — pass back to approve/reject. */
  id: string;
  host: string;
  port: number;
  /** True when the host:port already has a stored key that doesn't match
   *  what the server presented. Strong "MITM possible" signal — UI should
   *  show this very prominently. */
  is_changed_key: boolean;
  /** SHA-256 fingerprint of the key the server just presented. */
  fingerprint: string;
  /** SHA-256 of the previously-trusted key, if any. Show side-by-side. */
  previous_fingerprint: string | null;
  /** RFC3339 instant when the prompt was created — used to compute the
   *  ~120 s countdown shown in the modal. */
  created_at: string;
}

/** GET /api/host-keys/prompts — list currently-pending prompts. */
export async function listHostKeyPrompts(): Promise<HostKeyPrompt[]> {
  const { data } = await getClient().http.get('/host-keys/prompts');
  return Array.isArray(data) ? data : [];
}

/** Approve a prompt — the SSH handshake will proceed and the key is
 *  persisted to known_hosts. */
export async function approveHostKeyPrompt(id: string): Promise<void> {
  await getClient().http.post(`/host-keys/prompts/${id}/approve`);
}

/** Reject a prompt — the SSH handshake aborts with KeyError. */
export async function rejectHostKeyPrompt(id: string): Promise<void> {
  await getClient().http.post(`/host-keys/prompts/${id}/reject`);
}
