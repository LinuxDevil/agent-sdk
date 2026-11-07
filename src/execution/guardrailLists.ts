/**
 * The PII type and moderation category lists of `guardrailStarterSet.ts`,
 * in a leaf module so browser-safe spec files (`spec/guardrailOptions.ts`)
 * can validate guardrail option values without pulling `resolveProvider`
 * — and with it the provider stack — into a browser bundle.
 * `guardrailStarterSet.ts` re-exports them, so existing imports keep working.
 */
import type { ModerationCategory, PiiType } from './ioGuardrails';

/** Every {@link PiiType}, in the order overlapping matches are kept. */
export const PII_TYPES = ['iban', 'credit-card', 'us-ssn', 'email', 'ip-address', 'phone'] as const satisfies readonly PiiType[];

/** Every {@link ModerationCategory}. */
export const MODERATION_CATEGORIES = [
  'hate',
  'harassment',
  'self-harm',
  'sexual',
  'sexual-minors',
  'violence',
  'illicit',
] as const satisfies readonly ModerationCategory[];
