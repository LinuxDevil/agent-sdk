/**
 * The built-in secret scrubber `redactContent` runs on captured `gen_ai.*`
 * content: well-known API-key shapes become `[redacted]`. Each pattern needs
 * a long token after its prefix, so ordinary words (`sk-learn`, `task-`,
 * "a bearer of news") are left alone.
 */

/** What a matched secret is replaced with. */
const REDACTED = '[redacted]';

/**
 * OpenAI / OpenRouter (`sk-or-v1-`) / Anthropic (`sk-ant-`) style keys. A key
 * carries a digit; that is checked on the match, not with a lookahead, which
 * rescanned the rest of the run at every `sk-` and went quadratic on
 * `sk-sk-sk-…` (every pattern here must stay linear: tool output is untrusted).
 */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;

const SECRET_PATTERNS: RegExp[] = [
  // LangSmith.
  /\blsv2_[A-Za-z0-9_]{16,}/g,
  // GitHub tokens: classic (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Stripe secret / restricted keys.
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // Slack bot / app / user / refresh / legacy tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // JWTs: base64url header and payload (both `eyJ`, a `{"` object) and a signature.
  // Starts only at the head of a token run: a `\b` start also matched inside `eyJ-eyJ-…`, rescanning the run from each `eyJ` (quadratic).
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `Bearer <token>`: the word is kept, the token is redacted. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

/** Replaces API-key shapes in `text` with `[redacted]`. */
export function scrubSecrets(text: string): string {
  let scrubbed = text.replace(BEARER, `$1${REDACTED}`).replace(SK_KEY, (key) => (/\d/.test(key) ? REDACTED : key));
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED);
  }
  return scrubbed;
}

/** A custom redactor that throws redacts that text whole: telemetry never fails a run. */
export function safeRedactor(redact: (text: string) => string): (text: string) => string {
  return (text) => {
    try {
      return redact(text);
    } catch {
      return REDACTED;
    }
  };
}
