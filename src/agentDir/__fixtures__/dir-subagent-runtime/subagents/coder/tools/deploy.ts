import { z } from 'zod';
import { defineTool } from '../../../../../../tools/defineTool';

export default defineTool({ name: 'deploy', description: 'Deploy', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
