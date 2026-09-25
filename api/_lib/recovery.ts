/**
 * Shared pieces for email-based parent PIN recovery.
 *
 * WHY EMAIL
 * An earlier in-app design let the parent request a reset, wait out a delay,
 * then set a new PIN. It was unsound: the warning was a *local* notification
 * delivered to the very device the child holds, so a child could start a
 * reset, dismiss the alert, wait, and take ownership of the PIN.
 *
 * Recovery must require something the parent has and the child does not. A
 * delay is not that; an inbox is. Every path here ends at a link that only
 * reaches a verified address.
 *
 * THREAT MODEL — the adversary is a child holding an unlocked device who can
 * call these endpoints directly.
 *   - The PIN lives only on-device, so the server can never verify it. Any
 *     call that must be PIN-gated is gated client-side; the server assumes a
 *     caller may be hostile and grants nothing on their say-so.
 *   - Requesting a reset is harmless: it only mails an address the parent has
 *     already proven they own.
 *   - REBINDING is the dangerous operation. Changing an already-verified
 *     address requires clicking a link sent to the OLD address, so a child
 *     cannot point recovery at an inbox they control.
 *   - Tokens are single-use, short-lived, and stored only as SHA-256 hashes.
 */

import * as crypto from 'crypto';
import { db } from './firebase.js';

/** Verified sender. The domain is verified in Resend. */
const MAIL_FROM = 'EarnTime <noreply@earntime.c-lab.co.uk>';

/**
 * Link targets now live on the branded domain rather than
 * *.cloudfunctions.net — a recovery email that points at your own site is
 * considerably less likely to be taken for phishing.
 */
export const BASE_URL = 'https://earntime.c-lab.co.uk/api';

/** How long an emailed link stays valid. */
export const LINK_TTL_MS = 30 * 60 * 1000;
/** How long an approval stays usable before the parent must request again. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
/** Reset requests permitted per rolling 24h, per account. */
export const MAX_RESETS_PER_DAY = 5;

export const bindingRef = (uid: string) => db().doc(`users/${uid}/recovery/binding`);
export const resetRef = (uid: string) => db().doc(`users/${uid}/recovery/reset`);

export function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex');
}

export function newToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: sha256(token) };
}

/** Constant-time compare, so a token cannot be recovered by timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

/** Masks an address for display: a***@example.com */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***';
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, user.length - 1))}@${domain}`;
}

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Surfaced distinctly rather than as a generic failure — a missing key is
    // a deployment problem, not a transient send error.
    throw new Error('RESEND_API_KEY is not set');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[recovery] Resend failed:', res.status, body.slice(0, 300));
    throw new Error(`resend-${res.status}`);
  }
}

/** Minimal styled page returned to the browser after a link is clicked. */
export function page(title: string, message: string, ok: boolean): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0D1B2A;
       color:#fff;display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;padding:24px}
  .card{max-width:420px;text-align:center;background:#152232;padding:36px 28px;
        border-radius:20px}
  h1{font-size:20px;margin:16px 0 10px}
  p{color:#90A4AE;font-size:15px;line-height:1.5;margin:0}
  .icon{font-size:48px}
</style>
<div class="card">
  <div class="icon">${ok ? '✅' : '⚠️'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div>`;
}
