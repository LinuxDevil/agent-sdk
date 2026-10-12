// approvals.md:311
import { createAgent } from '@lousho/build-ai-agent';

const trusted = createAgent({
  provider,
  tools: [emailTool],
  approve: ({ toolName, args }) => toolName !== 'send_email' || String(args.to).endsWith('@example.com'),
});
export {};
