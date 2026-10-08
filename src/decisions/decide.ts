/**
 * OpenAI Decisions API — `POST {baseURL}/decisions`. A purpose-built endpoint
 * that evaluates shared input against typed questions (predicate / choice /
 * score) and returns calibrated probabilities, roughly 10x faster than a
 * Responses turn. This is the fast path for the "typed decision" pattern:
 * routing, confidence gates and rubric scores without a full agent run.
 *
 * Public beta: only `gpt-6-luna` is served; the surface may still change.
 */

import { z } from 'zod';
import { SDKError } from '../utils/sdkError';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-6-luna';
const DEFAULT_TIMEOUT_MS = 30_000;

/** A text part of a decision input message (the API's `input_text`). */
export interface DecisionTextPart {
  type: 'input_text';
  text: string;
}

/** An inline base64 image part; hosted URLs and `file_id` are not supported by the endpoint. */
export interface DecisionImagePart {
  type: 'input_image';
  /** A `data:image/...;base64,...` URL. */
  image_url: string;
}

export type DecisionInputPart = DecisionTextPart | DecisionImagePart;

/** One input message: shared evidence the questions are evaluated against. */
export interface DecisionInputMessage {
  role: string;
  content: DecisionInputPart[];
}

/** `predicate` — probability (0-1) that a condition holds, e.g. "is this spam". */
export interface PredicateQuestion {
  type: 'predicate';
  name: string;
  instructions: string;
}

/** `choice` — pick one of `choices`; for unordered categories like routing. */
export interface ChoiceQuestion {
  type: 'choice';
  name: string;
  instructions: string;
  choices: { value: string; description?: string }[];
}

/** `score` — probability-weighted position on ordered `levels`, e.g. severity rubrics. */
export interface ScoreQuestion {
  type: 'score';
  name: string;
  instructions: string;
  levels: { label: string; description?: string }[];
}

export type DecisionQuestion = PredicateQuestion | ChoiceQuestion | ScoreQuestion;

export interface PredicateAnswer {
  type: 'predicate';
  name: string;
  probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  name: string;
  choice: string;
  /** Per-option distribution over `choices`. */
  probabilities: { value: string; probability: number }[];
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  name: string;
  /** Probability-weighted level index; can fall between levels. */
  score: number;
  probabilities: { value: number; label: string; probability: number }[];
  confidence: number;
}

/** The model declined to answer this question. */
export interface RefusalAnswer {
  type: 'refusal';
  name: string;
}

export type DecisionAnswer = PredicateAnswer | ChoiceAnswer | ScoreAnswer | RefusalAnswer;

export interface DecisionResult {
  answers: DecisionAnswer[];
}

export interface DecideOptions {
  /** Shared evidence: a plain string, or messages mixing text and inline images. */
  input: string | DecisionInputMessage[];
  /** The questions to evaluate; each needs a unique `name`, echoed in `answers`. */
  questions: DecisionQuestion[];
  /** Decision model; `gpt-6-luna` is currently the only one served. */
  model?: string;
  /** Defaults to `OPENAI_API_KEY`. */
  apiKey?: string;
  /** Defaults to `https://api.openai.com/v1`; override for a compatible endpoint. */
  baseURL?: string;
  /** Defaults to `globalThis.fetch`; inject in tests. */
  fetch?: typeof globalThis.fetch;
  /** Aborts the HTTP request (merged with `timeoutMs`). */
  signal?: AbortSignal;
  /** Request timeout in ms; default 30s. */
  timeoutMs?: number;
}

const probabilitySchema = z.number().min(0).max(1);

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string(), probability: probabilitySchema }),
  z.object({
    type: z.literal('choice'),
    name: z.string(),
    choice: z.string(),
    probabilities: z.array(z.object({ value: z.string(), probability: probabilitySchema })),
    confidence: probabilitySchema,
  }),
  z.object({
    type: z.literal('score'),
    name: z.string(),
    score: z.number(),
    probabilities: z.array(
      z.object({ value: z.number(), label: z.string(), probability: probabilitySchema }),
    ),
    confidence: probabilitySchema,
  }),
  z.object({ type: z.literal('refusal'), name: z.string() }),
]);

const responseSchema = z.object({ answers: z.array(answerSchema) });

function validateQuestions(questions: DecisionQuestion[]): void {
  if (questions.length === 0) {
    throw new SDKError('decide() needs at least one question.', 'LOUSHO_CONFIG_INVALID');
  }
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.name) {
      throw new SDKError('Every decision question needs a unique `name`.', 'LOUSHO_CONFIG_INVALID');
    }
    if (seen.has(q.name)) {
      throw new SDKError(`Duplicate decision question name '${q.name}'.`, 'LOUSHO_CONFIG_INVALID');
    }
    seen.add(q.name);
    if (q.type === 'choice' && q.choices.length === 0) {
      throw new SDKError(`Choice question '${q.name}' needs at least one entry in 'choices'.`, 'LOUSHO_CONFIG_INVALID');
    }
    if (q.type === 'score' && q.levels.length < 2) {
      throw new SDKError(`Score question '${q.name}' needs at least two ordered 'levels'.`, 'LOUSHO_CONFIG_INVALID');
    }
  }
}

/**
 * Evaluate `questions` against `input` on the OpenAI Decisions API.
 *
 * ```ts
 * const { answers } = await decide({
 *   input: 'I was charged twice for my order.',
 *   questions: [{
 *     type: 'choice', name: 'route',
 *     instructions: 'Which team handles this?',
 *     choices: [
 *       { value: 'billing', description: 'Payments, invoices, refunds.' },
 *       { value: 'shipping', description: 'Delivery and tracking.' },
 *     ],
 *   }],
 * });
 * const route = answers[0]; // { type: 'choice', choice: 'billing', confidence: 0.93, ... }
 * ```
 *
 * Unlike `createAgent({ output })` this is one deterministic-shape call: no
 * tool loop, no generated prose, and calibrated `probabilities`/`confidence`
 * for thresholds. Needs `OPENAI_API_KEY` (or `apiKey`/`baseURL` for a
 * compatible endpoint); it is not part of the chat-completions surface, so it
 * does not go through providers or OpenRouter.
 */
export async function decide(options: DecideOptions): Promise<DecisionResult> {
  validateQuestions(options.questions);
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new SDKError(
      'decide() needs an OpenAI API key: pass apiKey or set OPENAI_API_KEY.',
      'LOUSHO_PROVIDER_MISSING_API_KEY',
    );
  }
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeout)];
  if (options.signal) signals.push(options.signal);

  const response = await request(options, baseURL, apiKey, AbortSignal.any(signals), timeout);
  return parseResponse(response, baseURL);
}

async function request(
  options: DecideOptions,
  baseURL: string,
  apiKey: string,
  signal: AbortSignal,
  timeout: number,
): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  try {
    return await doFetch(`${baseURL}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        input: options.input,
        questions: options.questions,
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new SDKError(
        `decide() request timed out or was aborted (timeout ${timeout}ms).`,
        'LOUSHO_OPERATION_TIMEOUT',
        { cause: error },
      );
    }
    throw new SDKError(
      `decide() request failed: ${error instanceof Error ? error.message : String(error)}`,
      'LOUSHO_PROVIDER_REQUEST_FAILED',
      { cause: error },
    );
  }
}

async function parseResponse(response: Response, baseURL: string): Promise<DecisionResult> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body.length > 300 ? `${body.slice(0, 300)}…` : body;
    const message = `decide() failed: POST ${baseURL}/decisions returned ${response.status}.${detail ? ` ${detail}` : ''}`;
    throw new SDKError(
      message,
      response.status === 429 ? 'LOUSHO_PROVIDER_RATE_LIMITED' : 'LOUSHO_PROVIDER_REQUEST_FAILED',
    );
  }
  const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new SDKError(
      `decide() returned an unexpected response shape: ${parsed.error.issues[0]?.message ?? 'invalid JSON'}.`,
      'LOUSHO_PROVIDER_REQUEST_FAILED',
    );
  }
  return parsed.data;
}
