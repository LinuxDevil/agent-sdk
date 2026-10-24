/**
 * The built-in secret scrubber `redactContent` runs on captured `gen_ai.*`
 * content: well-known API-key shapes become `[redacted]`. Each pattern needs
 * a long token after its prefix, so ordinary words (`sk-learn`, `task-`,
 * "a bearer of news") are left alone.
 */

/** What a matched secret is replaced with. */
export const REDACTED = '[redacted]';

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / OpenRouter (`sk-or-v1-`) / Anthropic (`sk-ant-`) style keys; a key carries a digit.
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g,
  // LangSmith.
  /\blsv2_[A-Za-z0-9_]{16,}/g,
  // GitHub tokens: classic (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** `Bearer <token>`: the word is kept, the token is redacted. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g;

/** Replaces API-key shapes in `text` with `[redacted]`. */
export function scrubSecrets(text: string): string {
  let scrubbed = text.replace(BEARER, `$1${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED);
  }
  return scrubbed;
}
