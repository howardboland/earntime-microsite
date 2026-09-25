/**
 * POST /api/recovery/status
 *
 * Whether a recovery email is bound, and whether a reset is approved right now.
 *
 * The address comes back MASKED. The app may be in a child's hands, so the
 * server never echoes the parent's full address to the client.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireMethod, requireUid } from '../_lib/firebase.js';
import { APPROVAL_TTL_MS, bindingRef, maskEmail, resetRef } from '../_lib/recovery.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireMethod(req, res, 'POST')) return;
  const uid = await requireUid(req, res);
  if (!uid) return;

  try {
    const [bindSnap, resetSnap] = await Promise.all([
      bindingRef(uid).get(),
      resetRef(uid).get(),
    ]);
    const binding = bindSnap.data();
    const reset = resetSnap.data();

    const approved =
      reset?.approved === true &&
      reset.consumed !== true &&
      Date.now() - Number(reset.approvedAt ?? 0) < APPROVAL_TTL_MS;

    res.status(200).json({
      bound: binding?.verified === true,
      email: binding?.verified === true ? maskEmail(String(binding.email)) : null,
      pending: !!binding?.pendingEmail,
      approved,
    });
  } catch (e) {
    console.error('[recovery/status] failed:', e);
    // Fail CLOSED on the flags: an unreadable status must never look like
    // "approved", or a Firestore blip would hand out a PIN reset.
    res.status(200).json({ bound: false, email: null, pending: false, approved: false });
  }
}
