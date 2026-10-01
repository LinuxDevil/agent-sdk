/**
 * Quota validation utilities for SaaS mode
 */

import { SaaSContext, QuotaValidationResult, QuotaConfig, UsageStats } from './types';

/**
 * Each quota dimension, in the order it is checked: the allowance on
 * QuotaConfig, the matching counter on UsageStats, and the message returned
 * once usage exceeds the allowance.
 */
interface QuotaCheck {
  allowed: keyof QuotaConfig;
  used: keyof UsageStats;
  message: string;
}

const QUOTA_CHECKS: readonly QuotaCheck[] = [
  { allowed: 'allowedResults', used: 'usedResults', message: 'You have reached the limit of results' },
  { allowed: 'allowedSessions', used: 'usedSessions', message: 'You have reached the limit of sessions' },
  { allowed: 'allowedUSDBudget', used: 'usedUSDBudget', message: 'You have reached the AI Tokens Limit' },
];

/**
 * A missing or zero allowance means "unlimited" (usage is not even read);
 * otherwise usage must not exceed it.
 */
function exceedsAllowance(quota: QuotaConfig, usage: UsageStats, check: QuotaCheck): boolean {
  const limit = quota[check.allowed] || 0;
  return limit > 0 && (usage[check.used] ?? 0) > limit;
}

/**
 * Validate token quotas against current usage
 * Returns a validation result with status code and message
 * 
 * @param saasContext - SaaS context containing quota and usage information
 * @param isSaaSEnabled - Whether SaaS mode is enabled (default: false)
 * @returns Validation result with message and HTTP status code
 */
export function validateTokenQuotas(
  saasContext: SaaSContext | undefined,
  isSaaSEnabled?: boolean
): QuotaValidationResult {
  if (!isSaaSEnabled) {
    return { message: 'SaaS is not enabled, quotas are not validated', status: 200 };
  }

  return validateUserQuotas(saasContext);
}

/**
 * The per-user checks run once SaaS mode is on: e-mail verification first,
 * then each quota dimension in QUOTA_CHECKS order.
 */
function validateUserQuotas(saasContext: SaaSContext | undefined): QuotaValidationResult {
  if (!saasContext?.emailVerified) {
    return { message: 'You must verify e-mail to use the AI features', status: 403 };
  }

  const { currentQuota, currentUsage } = saasContext;
  const exceeded = QUOTA_CHECKS.find((check) => exceedsAllowance(currentQuota, currentUsage, check));
  if (exceeded) {
    return { message: exceeded.message, status: 403 };
  }

  return { message: 'All OK!', status: 200 };
}
