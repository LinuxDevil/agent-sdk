// Offline: how does the SDK classify the context-overflow errors of local OpenAI-compatible servers?
import { APICallError } from 'ai';
import { compactProviderError, getModelInfo } from '@lousho/build-ai-agent';

const bodies = {
  'LM Studio (observed in this audit)': '{"error":"Engine protocol predict stream returned an error: {\\"code\\":500,\\"message\\":\\"Context size has been exceeded.\\",\\"type\\":\\"server_error\\"}"}',
  'llama.cpp server': '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}',
  'OpenAI (control)': '{"error":{"message":"This model\'s maximum context length is 8192 tokens","code":"context_length_exceeded"}}',
};
for (const [label, body] of Object.entries(bodies)) {
  const status = label.startsWith('LM') ? 500 : 400;
  const err = new APICallError({ message: JSON.parse(body).error?.message ?? JSON.parse(body).error, url: 'http://localhost:1234/v1/chat/completions', requestBodyValues: {}, statusCode: status, responseBody: body, isRetryable: status >= 500 });
  const c: any = compactProviderError(err, 'openai');
  console.log(`${label.padEnd(36)} status=${status} -> category=${c.category} retryable=${c.retryable}`);
}
console.log('getModelInfo(local model) =', JSON.stringify(getModelInfo('qwen3.5-9b-uncensored-hauhaucs-aggressive')), '-> compaction falls back to a 128000-token window');
