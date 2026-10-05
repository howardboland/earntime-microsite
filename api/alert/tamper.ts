/**
 * POST /api/alert/tamper
 *
 * Emails the parent when child mode is interfered with on the device.
 *
 * WHY THIS EXISTS
 * EarnTime's lock is drawn as a system overlay, and Android guarantees a user
 * can always revoke "display over other apps" — the platform posts its own
 * notification pointing at the setting, precisely so that malware cannot do
 * what a parental control wants to do. Revoking it removes the lock instantly
 * and completely. That hole cannot be closed from inside the app.
 *
 * So the goal here is not prevention, which is impossible, but evidence: turn
 * a silent, total bypass into something the parent is told about. The alert
 * deliberately goes to the verified recovery inbox rather than a device
 * notification, for the same reason PIN recovery does — a notification lands
 * on the device the child is holding, where they can dismiss it.
 *
 * The caller is assumed hostile: a child can reach this endpoint. It is
 * therefore rate-limited, reveals nothing in its response, and can only ever
 * mail an address the parent has already proven they own.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { db, requireMethod, requireUid } from '../_lib/firebase.js';
import { bindingRef, maskEmail, sendMail } from '../_lib/recovery.js';

/** Alerts permitted per rolling window, so this cannot flood an inbox. */
const MAX_ALERTS_PER_DAY = 6;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Human wording for each kind of interference the app can detect. */
const KINDS: Record<string, { label: string; detail: string }> = {
  overlay_permission_revoked: {
    label: 'the screen lock was switched off',
    detail:
      'EarnTime\'s "display over other apps" permission was turned off while child '
      + 'mode was active. That permission is what draws the lock screen, so child '
      + 'mode stopped working on the device until it was turned back on.',
  },
  accessibility_disabled: {
    label: 'app monitoring was switched off',
    detail:
      'EarnTime\'s App Monitor (accessibility access) was turned off while child '
      + 'mode was active. Without it the lock is slower to reappear when a child '
      + 'leaves the app.',
  },
  uninstall_protection_removed: {
    label: 'uninstall protection was removed',
    detail:
      'EarnTime\'s uninstall protection was switched off, so the app can now be '
      + 'removed from the device.',
  },
};

const alertRef = (uid: string) => db().doc(`users/${uid}/recovery/tamper`);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireMethod(req, res, 'POST')) return;
  const uid = await requireUid(req, res);
  if (!uid) return;

  const kind = String((req.body as { kind?: unknown })?.kind ?? '');
  const entry = KINDS[kind];
  if (!entry) {
    res.status(400).json({ error: 'invalid-argument', message: 'Unknown alert kind.' });
    return;
  }

  try {
    const binding = (await bindingRef(uid).get()).data();
    if (!binding?.verified || !binding.email) {
      // Nothing to alert to. Not an error the caller should learn anything
      // from — a child probing this should not discover whether recovery is
      // configured.
      res.status(200).json({ status: 'no-recipient' });
      return;
    }

    const now = Date.now();
    const prev = (await alertRef(uid).get()).data();
    const windowStart = Number(prev?.windowStart ?? 0);
    const inWindow = now - windowStart < WINDOW_MS;
    const count = inWindow ? Number(prev?.count ?? 0) : 0;

    // Record the event regardless of whether mail goes out, so the history is
    // complete even once the rate limit bites.
    await alertRef(uid).set(
      {
        count: count + 1,
        windowStart: inWindow ? windowStart : now,
        lastKind: kind,
        lastAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (count >= MAX_ALERTS_PER_DAY) {
      res.status(200).json({ status: 'rate-limited' });
      return;
    }

    const when = new Date(now).toUTCString();
    await sendMail(
      binding.email as string,
      `EarnTime: ${entry.label}`,
      `<p>A change was made on the EarnTime device that affects child mode.</p>
       <p><strong>${entry.label}</strong><br>${when}</p>
       <p>${entry.detail}</p>
       <p>If you made this change yourself, nothing is wrong and you can ignore
          this email.</p>
       <p>If you did not, it is likely someone using the device turned it off.
          Open EarnTime, check Parent Settings, and switch the setting back on.</p>
       <p style="color:#667">You are receiving this because this address is set
          as EarnTime's recovery email. Alerts are limited to
          ${MAX_ALERTS_PER_DAY} per day.</p>`
    );

    res.status(200).json({ status: 'sent', email: maskEmail(binding.email as string) });
  } catch (e) {
    console.error('[alert/tamper] failed:', e);
    // Fail quietly to the caller. A child who disabled the lock should not get
    // a clear signal about whether the parent was successfully told.
    res.status(200).json({ status: 'queued' });
  }
}
