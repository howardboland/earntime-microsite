/**
 * Firebase Admin: identity verification and Firestore access.
 *
 * These routes replace Firebase Cloud Functions, which gave two things for
 * free that must now be done explicitly:
 *
 *  1. `request.auth` — an already-verified caller identity. Here the app sends
 *     its Firebase ID token as a bearer header and we verify it ourselves.
 *  2. Ambient Admin SDK credentials. On Vercel there is no metadata server, so
 *     a service account is supplied through the FIREBASE_SERVICE_ACCOUNT env
 *     var.
 *
 * Everything else about the data model is unchanged: same project, same NAMED
 * `earntime` database, same document paths. The mobile app's own Firestore
 * access (profile backup, quiz cache) continues to go direct.
 */

import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * This project has NO `(default)` Firestore database — it has one named
 * `earntime`. Targeting the default fails with `5 NOT_FOUND`, which surfaces
 * to the app as an opaque "INTERNAL". Must match `databaseId` in the Flutter
 * client.
 */
const DATABASE_ID = 'earntime';

let cachedApp: App | undefined;

function app(): App {
  if (cachedApp) return cachedApp;
  if (getApps().length) {
    cachedApp = getApp();
    return cachedApp;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  }

  // Accept either raw JSON or base64 — pasting JSON into a dashboard env var
  // is easy to mangle (newlines in the private key especially), so base64 is
  // the safer form and the one worth using.
  const json = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');

  cachedApp = initializeApp({ credential: cert(JSON.parse(json)) });
  return cachedApp;
}

export function db(): Firestore {
  return getFirestore(app(), DATABASE_ID);
}

/**
 * Verifies the caller's Firebase ID token and returns their uid.
 *
 * Returns null and writes the response when the token is missing or invalid,
 * so callers can simply `if (!uid) return;`.
 *
 * Anonymous users are accepted deliberately — the app signs in anonymously at
 * launch and that uid is the identity everything is keyed to (quotas, recovery
 * bindings). What matters is that the token is genuine and issued for this
 * project, not that a human signed in.
 */
export async function requireUid(
  req: VercelRequest,
  res: VercelResponse
): Promise<string | null> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ error: 'unauthenticated', message: 'Sign-in required.' });
    return null;
  }

  try {
    const decoded = await getAuth(app()).verifyIdToken(token);
    return decoded.uid;
  } catch {
    // Do not echo the verification error — it distinguishes "expired" from
    // "forged", which is not information a hostile caller needs.
    res.status(401).json({ error: 'unauthenticated', message: 'Sign-in required.' });
    return null;
  }
}

/** Rejects anything but the given method, mirroring the old callable contract. */
export function requireMethod(
  req: VercelRequest,
  res: VercelResponse,
  method: 'GET' | 'POST'
): boolean {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  res.status(405).json({ error: 'method-not-allowed' });
  return false;
}
