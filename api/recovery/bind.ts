/**
 * POST /api/recovery/bind   { email }
 *
 * Sets or changes the address used to recover a forgotten parent PIN.
 * Called from the app behind the parent PIN — but that gate is client-side, so
 * nothing here trusts the caller.
 *
 * First binding  → verification link to the NEW address.
 * Re-binding     → confirmation link to the OLD address. This is the control
 *                  that stops a child pointing recovery at their own inbox;
 *                  without it everything downstream is worthless.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { requireMethod, requireUid } from '../_lib/firebase.js';
import {
  BASE_URL,
  LINK_TTL_MS,
  bindingRef,
  isValidEmail,
  maskEmail,
  newToken,
  sendMail,
} from '../_lib/recovery.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireMethod(req, res, 'POST')) return;
  const uid = await requireUid(req, res);
  if (!uid) return;

  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'invalid-argument', message: 'That email address looks wrong.' });
    return;
  }

  try {
    const existing = (await bindingRef(uid).get()).data();
    const { token, hash } = newToken();
    const expiresAt = Date.now() + LINK_TTL_MS;

    await bindingRef(uid).set(
      {
        pendingEmail: email,
        verifyHash: hash,
        verifyExpiresAt: expiresAt,
        // An unverified first binding must not look usable.
        verified: existing?.verified === true,
        email: existing?.email ?? FieldValue.delete(),
        source: 'manual',
      },
      { merge: true }
    );

    const link = `${BASE_URL}/recovery/confirm-email?t=${token}&u=${uid}`;

    if (existing?.verified === true && existing.email && existing.email !== email) {
      // Re-binding: the OLD inbox authorises the change.
      await sendMail(
        existing.email as string,
        'Confirm the change to your EarnTime recovery email',
        `<p>Someone asked to change the EarnTime PIN-recovery address on your device to
          <strong>${email}</strong>.</p>
         <p>If that was you, confirm it here (the link lasts 30 minutes):</p>
         <p><a href="${link}">Confirm the new recovery email</a></p>
         <p><strong>If this was not you, do nothing.</strong> Someone with access to the
          device is trying to take over PIN recovery. The address stays unchanged unless
          this link is clicked.</p>`
      );
      res.status(200).json({ status: 'confirm_sent_to_old', email: maskEmail(existing.email as string) });
      return;
    }

    await sendMail(
      email,
      'Confirm your EarnTime recovery email',
      `<p>Confirm this address so you can reset your EarnTime parent PIN if you forget it.</p>
       <p><a href="${link}">Confirm this email</a></p>
       <p>The link lasts 30 minutes. If you didn't request this, ignore it.</p>`
    );
    res.status(200).json({ status: 'verification_sent', email: maskEmail(email) });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error('[recovery/bind] failed:', e);
    res.status(msg.includes('RESEND_API_KEY') ? 500 : 502).json({
      error: msg.includes('RESEND_API_KEY') ? 'mail-not-configured' : 'mail-failed',
      message: 'Could not send the email. Try again shortly.',
    });
  }
}
