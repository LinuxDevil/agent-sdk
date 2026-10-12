import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
export default defineTool({ name: 'deploy', description: 'Deploy', input: z.object({}), needsApproval: true, execute: async () => 'deployed' });
