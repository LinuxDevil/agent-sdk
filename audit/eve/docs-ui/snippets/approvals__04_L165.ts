// approvals.md:165
import { createAgent, defineTool, once } from '@lousho/build-ai-agent';
import { z } from 'zod';

const askOnce = once();
const deploy = defineTool({
  name: 'deploy',
  description: 'Deploy a service',
  input: z.object({ service: z.string(), env: z.enum(['staging', 'prod']) }),
  needsApproval: (args, ctx) => (args.env === 'prod' ? { deny: 'Production deploys go through CI' } : askOnce(args, ctx)),
  execute: async ({ service, env }) => `deployed ${service} to ${env}`,
});
const agent = createAgent({ provider, instructions: 'You deploy services.', tools: [deploy] });
const chat = agent.session(); // the first staging deploy asks, later ones in this session run
export {};
