/**
 * Mock Grafana/Datadog webhook sender (LOU-J8) - same call shape as a real
 * monitoring source: a plain HTTP POST of an ErrorSignal JSON body to the
 * pipeline's /webhook endpoint. Used by the demo's "post a synthetic
 * error" script; posts only to the demo's own localhost server, so this
 * never reaches the real network either.
 */
import { ErrorSignal } from '../monitor';

export async function sendSyntheticError(webhookUrl: string, signal: ErrorSignal): Promise<Response> {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signal),
  });
}

/** A representative synthetic error signal for the demo. */
export function exampleErrorSignal(): ErrorSignal {
  return {
    signature: 'demo-npe-order-service',
    service: 'grafana',
    message: 'NullPointerException in OrderService.charge',
    logs: [
      'java.lang.NullPointerException',
      '\tat OrderService.charge(OrderService.java:42)',
      '\tat OrderController.checkout(OrderController.java:18)',
    ].join('\n'),
  };
}
