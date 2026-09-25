/**
 * GET /api/recovery/confirm-reset?t=<token>&u=<uid>
 *
 * Clicked from the inbox. Marks a pending reset as approved.
 *
 * Unauthenticated for the same reason as confirm-email: it opens in a mail
 * client's browser with no Firebase session. The single-use token is the
 * credential.
 *
 * Approval is deliberately short-lived and burned on use, so a link found in
 * an inbox weeks later grants nothing.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { page, resetRef, safeEqual, sha256 } from '../_lib/recovery.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const token = String(req.query.t ?? '');
  const uid = String(req.query.u ?? '');

  if (!token || !uid) {
    res.status(400).send(page('Invalid link', 'This link is missing information.', false));
    return;
  }

  try {
    const ref = resetRef(uid);
    const data = (await ref.get()).data();

    if (!data?.tokenHash || data.consumed === true) {
      res.status(410).send(page('Link already used', 'This reset link has already been used.', false));
      return;
    }
    if (Date.now() > Number(data.expiresAt ?? 0)) {
      res.status(410).send(
        page('Link expired', 'Reset links last 30 minutes. Request a new one from the app.', false)
      );
      return;
    }
    if (!safeEqual(sha256(token), String(data.tokenHash))) {
      res.status(403).send(page('Invalid link', 'This link is not valid.', false));
      return;
    }

    await ref.set(
      {
        approved: true,
        approvedAt: Date.now(),
        // Burn the token: approval is granted once.
        tokenHash: FieldValue.delete(),
      },
      { merge: true }
    );

    res.status(200).send(
      page(
        'PIN reset approved',
        'Go back to EarnTime on your device and choose a new PIN within the next 15 minutes.',
        true
      )
    );
  } catch (e) {
    console.error('[recovery/confirm-reset] failed:', e);
    res.status(500).send(page('Something went wrong', 'Please try the link again shortly.', false));
  }
}
