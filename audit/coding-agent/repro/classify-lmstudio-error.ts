/** How the SDK classifies LM Studio's context-overflow error (it is neither retried nor tagged context-length). */
import { isRetryableProviderError } from '@lousho/build-ai-agent';
import * as sdk from '@lousho/build-ai-agent';
const msg = 'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}';
const compact = (sdk as unknown as { compactProviderError?: (e: unknown) => unknown }).compactProviderError;
for (const err of [new Error(msg), Object.assign(new Error(msg), { statusCode: 500 }), { type: 'error', error: { code: 500, message: 'Context size has been exceeded.' } }]) {
  console.log(JSON.stringify(err instanceof Error ? { message: err.message.slice(0, 60), statusCode: (err as { statusCode?: number }).statusCode } : err).slice(0, 90));
  console.log('  retryable:', isRetryableProviderError(err), ' compacted:', compact ? JSON.stringify(compact(err)) : '(compactProviderError not exported)');
}
