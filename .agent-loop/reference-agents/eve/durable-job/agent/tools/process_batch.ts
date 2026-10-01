import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Process one batch of the import (0-9). Slow.",
  inputSchema: z.object({ batch: z.number().int().min(0).max(9) }),
  async execute({ batch }) {
    if (Number(process.env.CRASH_AT) === batch) process.exit(1); // simulated crash
    await new Promise((r) => setTimeout(r, 1_000));
    return { batch, rows: 1_000 };
  },
});
