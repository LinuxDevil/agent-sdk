import { webhookChannel } from '@lousho/build-ai-agent';

/**
 * Alert intake (PagerDuty-style): POSTs land on /channels/alerts; the JSON
 * body's `input` string - or the whole body - becomes the alert the agent
 * works on, and a `sessionKey` keeps one incident in one session.
 *
 * With INCIDENT_WEBHOOK_SECRET set, requests must carry a GitHub-style
 * 'x-signature-256: sha256=<hmac of the raw body>' header. Without it the
 * channel accepts unauthenticated requests - local development only; always
 * set the secret in a deployment.
 */
export default webhookChannel({
  name: 'alerts',
  ...(process.env.INCIDENT_WEBHOOK_SECRET ? { secret: process.env.INCIDENT_WEBHOOK_SECRET } : {}),
});
