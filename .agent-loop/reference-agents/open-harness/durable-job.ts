// (c) Durable job. open-harness has no durable execution: Session saves the
// transcript through a SessionStore only when a turn completes
// (packages/core/src/session.ts, "Persist"), and ships no store
// implementation. A crash mid-turn loses that turn; "resume" re-sends it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Agent, Session, type SessionStore } from "@openharness/core";
import { openai } from "@ai-sdk/openai";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";

const fileStore: SessionStore = {
  async load(id) {
    try { return JSON.parse(await readFile(`.jobs/${id}.json`, "utf8")) as ModelMessage[]; } catch { return undefined; }
  },
  async save(id, messages) {
    await mkdir(".jobs", { recursive: true });
    await writeFile(`.jobs/${id}.json`, JSON.stringify(messages));
  },
};

const processBatch = tool({
  description: "Process one batch of the import (0-9). Slow.",
  inputSchema: z.object({ batch: z.number().int().min(0).max(9) }),
  async execute({ batch }) {
    if (Number(process.env.CRASH_AT) === batch) process.exit(1); // simulated crash
    await new Promise((r) => setTimeout(r, 1_000));
    return { batch, rows: 1_000 };
  },
});

const agent = new Agent({
  name: "importer",
  model: openai("gpt-5.4"),
  systemPrompt: "Process batches 0 to 9 one at a time with process_batch, then report the total rows.",
  tools: { process_batch: processBatch },
  maxSteps: 40,
});

const [command = "start", sessionId = "job-1", text] = process.argv.slice(2);
const session = new Session({ agent, sessionId, sessionStore: fileStore, contextWindow: 128_000 });
await session.load();
// After a crash the last saved turn is the one before the crash: re-send the job.
const input = command === "continue" ? (text ?? "Summarize the run.") : "Run the import.";
for await (const event of session.send(input)) {
  if (event.type === "text.delta") process.stdout.write(event.text);
}
process.stdout.write("\n");
