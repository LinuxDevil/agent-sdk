// nextjs.md:39
import { createAgent, createRouteHandler } from '@lousho/build-ai-agent';

declare function isSignedIn(request: Request): Promise<boolean>;

export const { GET, POST } = createRouteHandler(createAgent({ model: 'openai/gpt-4o-mini' }), {
  auth: (request) => isSignedIn(request),
});
export {};
