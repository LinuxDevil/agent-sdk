import { webhookChannel } from '@lousho/build-ai-agent';

// Verifies `x-signature-256: sha256=<hmac of the raw body>` against WEBHOOK_SECRET
// (the format GitHub webhooks use). The channel refuses to load when the secret
// is not set, so a deployment can never run unauthenticated by accident.
export default webhookChannel({
  name: 'generic-webhook',
  secret: process.env.WEBHOOK_SECRET ?? '',
});
