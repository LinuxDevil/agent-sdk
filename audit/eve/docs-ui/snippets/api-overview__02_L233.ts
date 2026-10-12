// api-overview.md:233
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email', // 1-64 chars: letters, digits, _ and -
  description: 'Send an email',
  input: z.object({ to: z.string().email(), subject: z.string() }),
  needsApproval: ({ to }) => !to.endsWith('@mycompany.com'), // `to` is typed
  async execute({ to, subject }) {
    return { messageId: `${to}:${subject}` };
  },
});
export {};
