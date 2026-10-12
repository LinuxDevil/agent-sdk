// sessions.md:262
import { createAgent, fileStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, store: fileStore('./.lousho') });
// ./.lousho/sessions/user-42.json, ./.lousho/checkpoints/..., ./.lousho/approvals/...
await agent.session({ id: 'user-42' }).send('Hello');
export {};
