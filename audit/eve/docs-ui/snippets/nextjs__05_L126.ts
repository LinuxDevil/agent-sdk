// nextjs.md:126
import { createAgent, createRouteHandler } from '@lousho/build-ai-agent';

const { handler } = createRouteHandler(createAgent({ model: 'openai/gpt-4o-mini' }), { basePath: '/agent', auth: 'secret' });

// SvelteKit: src/routes/agent/[...path]/+server.ts
export const GET = ({ request }: { request: Request }) => handler(request);
export const POST = ({ request }: { request: Request }) => handler(request);

// Hono: app.all('/agent/*', (c) => handler(c.req.raw))
// Bun.serve: fetch: handler
export {};
