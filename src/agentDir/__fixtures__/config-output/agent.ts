import { z } from 'zod';

export default {
  instructions: 'Answer with the city and its temperature.',
  retry: { maxRetries: 1, timeoutMs: 5000 },
  output: z.object({ city: z.string(), tempC: z.number() }),
};
