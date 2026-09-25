/**
 * POST /api/recovery/consume
 *
 * Burns an approval. The client calls this immediately before letting the
 * parent choose a new PIN, so one emailed link grants exactly one reset.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { requireMethod, requireUid } from '../_lib/firebase.js';
import { APPROVAL_TTL_MS, resetRef } from '../_lib/recovery.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireMethod(req, res, 'POST')) return;
  const uid = await requireUid(req, res);
  if (!uid) return;

  try {
    const ref = resetRef(uid);
    const data = (await ref.get()).data();

    const approved =
      data?.approved === true &&
      data.consumed !== true &&
      Date.now() - Number(data.approvedAt ?? 0) < APPROVAL_TTL_MS;

    if (!approved) {
      res.status(412).json({
        error: 'failed-precondition',
        message: 'No approved PIN reset to use.',
      });
      return;
    }

    await ref.set(
      { consumed: true, approved: false, consumedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    res.status(200).json({ status: 'consumed' });
  } catch (e) {
    console.error('[recovery/consume] failed:', e);
    // Fail CLOSED: if the burn cannot be recorded, do not report success — a
    // client that proceeds on a false success would get a reset that was never
    // consumed, leaving the link reusable.
    res.status(500).json({ error: 'internal', message: 'Could not complete the reset.' });
  }
}
