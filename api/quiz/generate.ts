/**
 * POST /api/quiz/generate
 *
 * Generates multiple-choice quiz questions with Claude, and caches them in the
 * shared Firestore bank so other devices get the same seed for free.
 *
 * Ported from the `generateQuiz` Firebase Cloud Function. The prompt, parsing,
 * quota and caching behaviour are deliberately identical — only the host and
 * the auth mechanism changed. Callable auth (`request.auth`) becomes an
 * explicitly verified bearer token.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { CLAUDE_MODEL, claude } from '../_lib/claude.js';
import { db, requireMethod, requireUid } from '../_lib/firebase.js';

interface QuizRequest {
  subject: string;
  topicSlug: string;
  topicLabel: string;
  topicDescription: string;
  topicExampleQuestion: string;
  topicExampleAnswer: string;
  topicExampleWorking: string;
  band: string;
  difficulty: string;
  completedCount: number;
  count: number;
  seed: number;
}

interface Question {
  prompt: string;
  options: string[];
  correctAnswer: string;
  xpReward: number;
  hint: string;
}

/**
 * Generations allowed per account per rolling 24h. Every call past the cache
 * is a paid Claude request, and the app signs in anonymously — so "must be
 * authenticated" is not a barrier on its own. 50 is generous for real use:
 * five quizzes a day across four profiles is 20, and cached seeds never reach
 * this endpoint.
 */
const MAX_QUIZZES_PER_DAY = 50;

function bandTeacherLabel(band: string): string {
  switch (band) {
    case 'earlyYears': return 'friendly primary school teacher for 5-7 year olds';
    case 'junior':     return 'engaging junior school teacher for 8-10 year olds';
    default:           return 'knowledgeable secondary school teacher for 11-13 year olds';
  }
}

function difficultyInstruction(difficulty: string): string {
  switch (difficulty) {
    case 'easy':
      return [
        'EASY MODE — follow these rules strictly:',
        '- Questions must test a single, simple fact — no multi-step reasoning.',
        '- Use short sentences (under 12 words). Avoid subordinate clauses.',
        '- For Maths: use small whole numbers only (1–20). No fractions, decimals, or carrying.',
        '- For English/Languages: use only very common everyday words a 6-year-old would know.',
        '- Wrong answer options must be clearly different from the correct answer (no trick near-misses).',
        '- Every question must be answerable in under 10 seconds by a child who knows the topic.',
        '- If in doubt, make it easier.',
      ].join('\n');
    case 'medium':
      return 'Include application questions requiring multi-step thinking. Use realistic scenarios.';
    default:
      return 'Use challenging questions with tricky edge cases, complex application, and subtle distinctions.';
  }
}

function buildSystemPrompt(req: QuizRequest): string {
  return `You are a ${bandTeacherLabel(req.band)}. Generate multiple-choice quiz questions about "${req.topicLabel}".

Topic context: ${req.topicDescription}

Example question style:
Q: ${req.topicExampleQuestion}
A: ${req.topicExampleAnswer}
Explanation: ${req.topicExampleWorking}

Difficulty level: ${req.difficulty}
${difficultyInstruction(req.difficulty)}
This child has completed ${req.completedCount} prior quizzes at this difficulty — progressively increase challenge within this difficulty band.

STRICT RULES:
- Return ONLY valid JSON, no preamble or markdown
- Schema: {"questions": [{"prompt": "...", "options": ["a","b","c","d"], "correctAnswer": "...", "xpReward": 10, "hint": "..."}]}
- Spread correct answers across all 4 positions — do NOT put the correct answer in position 1 or 2 for every question
- Exactly 4 options per question
- correctAnswer must be one of the 4 options verbatim
- Keep questions fun, clear and age-appropriate
- Vary difficulty slightly across the ${req.count} questions`;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseQuestions(text: string, count: number): Question[] {
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}') + 1;
  if (jsonStart < 0 || jsonEnd <= jsonStart) return [];

  const parsed = JSON.parse(text.substring(jsonStart, jsonEnd));
  const list: Question[] = (parsed.questions as Question[]).slice(0, count);

  return list
    .filter(
      (q) =>
        q.prompt &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.correctAnswer &&
        q.options.includes(q.correctAnswer)
    )
    .map((q) => ({ ...q, options: shuffle([...q.options]) }));
}

/**
 * Counts one generation against the caller's daily quota, in a transaction —
 * a read-then-write loses count under concurrent calls, which is exactly the
 * pattern abuse produces.
 *
 * Fails OPEN on an unexpected Firestore error: a metering outage must not stop
 * children earning screen time. Fails closed only on a real quota breach.
 */
async function consumeQuota(uid: string): Promise<boolean> {
  const firestore = db();
  const ref = firestore.doc(`users/${uid}/usage/quiz`);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  try {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.data();
      const windowStart = Number(d?.windowStart ?? 0);
      const inWindow = now - windowStart < dayMs;
      const count = inWindow ? Number(d?.count ?? 0) : 0;

      if (count >= MAX_QUIZZES_PER_DAY) {
        throw new Error('QUOTA_EXCEEDED');
      }
      tx.set(
        ref,
        { count: count + 1, windowStart: inWindow ? windowStart : now },
        { merge: true }
      );
    });
    return true;
  } catch (e) {
    if (e instanceof Error && e.message === 'QUOTA_EXCEEDED') return false;
    console.warn('[quiz/generate] quota check failed, allowing:', e);
    return true;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireMethod(req, res, 'POST')) return;

  const uid = await requireUid(req, res);
  if (!uid) return;

  const data = req.body as QuizRequest;
  if (!data?.topicSlug || !data.difficulty || !data.band) {
    res.status(400).json({ error: 'invalid-argument', message: 'Missing required quiz parameters.' });
    return;
  }

  // Meter BEFORE spending anything — every call past here is paid.
  if (!(await consumeQuota(uid))) {
    res.status(429).json({
      error: 'resource-exhausted',
      message: 'Daily quiz limit reached. More quizzes will be available tomorrow.',
    });
    return;
  }

  let questions: Question[];
  try {
    const message = await claude().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(data),
      messages: [
        {
          role: 'user',
          content: `Generate ${data.count} multiple-choice questions. Variation seed: ${data.seed}. Return JSON only.`,
        },
      ],
    });

    const block = message.content.find((b) => b.type === 'text');
    questions = block && block.type === 'text' ? parseQuestions(block.text, data.count) : [];
  } catch (e) {
    // Classify rather than collapsing everything into "upstream". A missing
    // credential, a bad credential and a genuine Claude outage need different
    // fixes, and an undifferentiated 502 sends you looking in the wrong place
    // — which has already happened twice on this project.
    const msg = (e as Error)?.message ?? String(e);
    console.error('[quiz/generate] Claude call failed:', e);

    let code = 'upstream';
    if (/GCP_SA_KEY_B64 is not set/i.test(msg)) {
      code = 'vertex-credentials-missing';
    } else if (/invalid_grant|Invalid JWT|unauthorized|401|403/i.test(msg)) {
      // Almost always a revoked key, or base64 that lost its trailing "=".
      code = 'vertex-credentials-rejected';
    } else if (/not found|404|does not have access/i.test(msg)) {
      code = 'vertex-model-unavailable';
    } else if (/JSON|Unexpected token/i.test(msg)) {
      code = 'vertex-credentials-malformed';
    }

    res.status(code === 'upstream' ? 502 : 500).json({
      error: code,
      message: 'Could not generate questions right now.',
    });
    return;
  }

  if (questions.length === 0) {
    res.status(502).json({ error: 'upstream', message: 'Claude returned no valid questions.' });
    return;
  }

  // Trailblazer cache: store so other devices get this seed without paying.
  // Deliberately server-side — the client must not write the SHARED bank, or a
  // tampered client could plant trivial questions for every other child.
  try {
    await db()
      .doc(`quizBank/${data.subject}/${data.topicSlug}/${data.band}/${data.difficulty}/seed_${data.seed}`)
      .set({ questionsJson: JSON.stringify(questions), generatedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    console.warn('[quiz/generate] Firestore cache write failed:', e);
  }

  res.status(200).json({ questions });
}
