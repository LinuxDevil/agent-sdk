/**
 * Trigger adapters module (LOU-T5)
 *
 * Public surface for `@loushy/build-ai-agent/triggers`: the TriggerAdapter
 * interface, TriggerRegistry, and the three built-in adapters
 * (webhook/cron/slack). See types.ts for the full design rationale.
 */

export * from './types';
export * from './TriggerRegistry';
export * from './adapters/WebhookTriggerAdapter';
export * from './webhookAuth';
export * from './cronExpression';
export * from './adapters/CronTriggerAdapter';
export * from './adapters/SlackTriggerAdapter';
