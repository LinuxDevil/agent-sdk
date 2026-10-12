// tools.md:204
import { createAgent, createWebFetchTool } from '@lousho/build-ai-agent';

const webFetch = createWebFetchTool({
  timeoutMs: 30_000, // whole request: redirects and body included
  maxRedirects: 10, // each hop is checked again
  maxBytes: 2 * 1024 * 1024, // read from the network, then stop (truncated: true)
  maxChars: 50_000, // characters of text returned to the model
  allowedHosts: ['*.example.com', 'example.com'], // `*.` matches subdomains only, so list the bare host too; when set, any other host is refused before DNS
  blockedHosts: ['private.example.com'], // always refused, before DNS
  allowPrivate: [], // hosts allowed to resolve to private addresses
  userAgent: 'lousho-web-fetch',
});

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [webFetch] });
export {};
