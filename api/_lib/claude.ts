/**
 * Claude access, via Google Vertex AI.
 *
 * WHY VERTEX AND NOT THE DIRECT ANTHROPIC API
 * The GCP project `bmckxff-lovelace` is where this app's Vertex access lives.
 * Note it only grants `claude-opus-4-6` — claude-haiku-4-5, claude-sonnet-5
 * and claude-opus-5 all return 404 "your project does not have access to it".
 * So the model cannot be changed without someone with owner rights on that
 * project enabling others, or moving to the direct Anthropic API (one
 * `sk-ant-` key, no GCP dependency at all).
 *
 * That dependency has bitten before: the service account key was revoked in
 * September 2026 and quiz generation failed for every user until it was
 * replaced, with the app misreporting it as "You're offline".
 */

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { GoogleAuth } from 'google-auth-library';

const GCP_PROJECT = 'bmckxff-lovelace';

/** The only model this Vertex project grants access to. */
export const CLAUDE_MODEL = 'claude-opus-4-6';

/**
 * `global` matches the endpoint the Cloud Function used. Vertex also accepts a
 * multi-region or a specific region; global is the recommended default.
 */
const REGION = 'global';

let cached: AnthropicVertex | undefined;

export function claude(): AnthropicVertex {
  if (cached) return cached;

  const raw = process.env.GCP_SA_KEY_B64;
  if (!raw) {
    throw new Error('GCP_SA_KEY_B64 is not set');
  }

  // Base64 of the service account JSON, same encoding the Cloud Function used.
  // Padding matters: a value whose length is not a multiple of 4 decodes to
  // garbage, which surfaces as `invalid_grant: Invalid JWT Signature` — the
  // same error as a genuinely revoked key, and very easy to misdiagnose.
  const credentials = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));

  cached = new AnthropicVertex({
    googleAuth: new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    }),
    projectId: GCP_PROJECT,
    region: REGION,
    // The SDK derives its host as `https://${region}-aiplatform.googleapis.com`,
    // which for region "global" yields `global-aiplatform.googleapis.com` — a
    // host that does not exist. The global endpoint is unprefixed. Without this
    // override every call 404s, indistinguishably from the model genuinely not
    // being available on the project.
    //
    // The request PATH still uses `/locations/global/...`, which is correct and
    // matches what the Cloud Function sent.
    baseURL: 'https://aiplatform.googleapis.com/v1',
  });
  return cached;
}
