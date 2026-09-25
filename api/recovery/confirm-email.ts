/**
 * GET /api/recovery/confirm-email?t=<token>&u=<uid>
 *
 * Clicked from the inbox. Promotes a pending address to verified.
 *
 * Deliberately unauthenticated: it is opened in a mail client's browser, which
 * carries no Firebase session. The unguessable single-use token IS the
 * credential, which is why it is 32 random bytes stored only as a hash.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { bindingRef, page, safeEqual, sha256 } from '../_lib/recovery.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const token = String(req.query.t ?? '');
  const uid = String(req.query.u ?? '');

  if (!token || !uid) {
    res.status(400).send(page('Invalid link', 'This link is missing information.', false));
    return;
  }

  try {
    const ref = bindingRef(uid);
    const data = (await ref.get()).data();

    if (!data?.verifyHash || !data.pendingEmail) {
      res.status(410).send(
        page('Link already used', 'This confirmation link has already been used, or was cancelled.', false)
      );
      return;
    }
    if (Date.now() > Number(data.verifyExpiresAt ?? 0)) {
      res.status(410).send(
        page('Link expired', 'Confirmation links last 30 minutes. Request a new one from the app.', false)
      );
      return;
    }
    if (!safeEqual(sha256(token), String(data.verifyHash))) {
      res.status(403).send(page('Invalid link', 'This link is not valid.', false));
      return;
    }

    await ref.set(
      {
        email: data.pendingEmail,
        verified: true,
        boundAt: FieldValue.serverTimestamp(),
        pendingEmail: FieldValue.delete(),
        verifyHash: FieldValue.delete(),
        verifyExpiresAt: FieldValue.delete(),
      },
      { merge: true }
    );

    res.status(200).send(
      page(
        'Recovery email confirmed',
        'You can now reset your EarnTime parent PIN from this address if you ever forget it.',
        true
      )
    );
  } catch (e) {
    console.error('[recovery/confirm-email] failed:', e);
    res.status(500).send(page('Something went wrong', 'Please try the link again shortly.', false));
  }
}
