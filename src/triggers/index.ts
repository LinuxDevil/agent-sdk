/**
 * Trigger adapters module
 *
 * Public surface for `lousho/triggers`: the TriggerAdapter
 * interface, TriggerRegistry, and the three built-in adapters
 * (webhook/cron/slack). See types.ts for the full design rationale.
 */

export * from './types';
export * from './TriggerRegistry';
export * from './webhookAuth';
export * from './cronExpression';
