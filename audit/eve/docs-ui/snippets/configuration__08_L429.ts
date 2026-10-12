// configuration.md:429
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  instructions: 'You review pull requests.',
  provider,
  projectInstructions: true, // or { cwd: './packages/api', files: ['AGENTS.md'] }
});
export {};
