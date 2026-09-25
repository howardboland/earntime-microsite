/**
 * POST /api/recovery/request-reset
 *
 * Emails a reset link to the bound address.
 *
 * Safe for anyone to call, including a child: it only mails an address the
 * parent has already proven they own, and it is rate-limited so it cannot be
 * used to flood that inbox.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { requireMethod, requireUid } from '../_lib/firebase.js';
import {
  BASE_URL,
  LINK_TTL_MS,
  MAX_RESETS_PER_DAY,
  bindingRef,
  maskEmail,
  newToken,
  resetRef,
  sendMail,
} from '../_lib/recovery.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireMethod(req, res, 'POST')) return;
  const uid = await requireUid(req, res);
  if (!uid) return;

  try {
    const binding = (await bindingRef(uid).get()).data();
    if (!binding?.verified || !binding.email) {
      res.status(412).json({
        error: 'failed-precondition',
        message: 'No confirmed recovery email is set up on this device.',
      });
      return;
    }

    const now = Date.now();
    const prev = (await resetRef(uid).get()).data();
    const windowStart = Number(prev?.windowStart ?? 0);
    const inWindow = now - windowStart < 24 * 60 * 60 * 1000;
    const count = inWindow ? Number(prev?.requestCount ?? 0) : 0;

    if (count >= MAX_RESETS_PER_DAY) {
      res.status(429).json({
        error: 'resource-exhausted',
        message: 'Too many reset emails today. Try again tomorrow.',
      });
      return;
    }

    const { token, hash } = newToken();
    await resetRef(uid).set(
      {
        tokenHash: hash,
        expiresAt: now + LINK_TTL_MS,
        approved: false,
        consumed: false,
        requestedAt: FieldValue.serverTimestamp(),
        requestCount: count + 1,
        windowStart: inWindow ? windowStart : now,
      },
      { merge: true }
    );

    const link = `${BASE_URL}/recovery/confirm-reset?t=${token}&u=${uid}`;
    await sendMail(
      binding.email as string,
      'Reset your EarnTime parent PIN',
      `<p>Someone asked to reset the parent PIN on your EarnTime device.</p>
       <p>To allow it, click here within 30 minutes:</p>
       <p><a href="${link}">Allow the PIN reset</a></p>
       <p>Then return to the app and choose a new PIN. Profiles, earned time and
          progress are unaffected.</p>
       <p><strong>If this was not you, do nothing.</strong> The PIN stays as it is
          unless this link is clicked.</p>`
    );

    res.status(200).json({ status: 'sent', email: maskEmail(binding.email as string) });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error('[recovery/request-reset] failed:', e);
    res.status(msg.includes('RESEND_API_KEY') ? 500 : 502).json({
      error: msg.includes('RESEND_API_KEY') ? 'mail-not-configured' : 'mail-failed',
      message: 'Could not send the reset email. Try again shortly.',
    });
  }
}
