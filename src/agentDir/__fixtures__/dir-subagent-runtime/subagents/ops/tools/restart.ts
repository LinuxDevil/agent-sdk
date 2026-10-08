import { z } from 'zod';
import { defineTool } from '../../../../../../tools/defineTool';

export default defineTool({ name: 'restart', description: 'Restart a service', input: z.object({}), needsApproval: true, execute: () => 'restarted' });
