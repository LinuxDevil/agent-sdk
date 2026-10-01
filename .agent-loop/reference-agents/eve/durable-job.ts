// (c) Durable job. Every model step is a Workflow checkpoint
// (docs/concepts/execution-model-and-durability.mdx). Server: `eve dev --no-ui`
// (or `eve build && eve start` with a persistent Workflow world).
//   tsx durable-job.ts start            -> crash the server (CRASH_AT=3)
//   restart with `eve dev --no-ui --resume`, then: tsx durable-job.ts resume
//   tsx durable-job.ts continue "Now write a summary"
import { readFile, writeFile } from "node:fs/promises";
import { Client, type ClientSessionState } from "eve/client";

const client = new Client({ host: "http://127.0.0.1:2000" });
const [command = "start", text] = process.argv.slice(2);

if (command === "start") {
  const { session, response } = await client.sessions.create({ message: "Run the import." });
  await writeFile("job.json", JSON.stringify(session.state));
  console.log((await response.result()).message);
} else {
  const saved = JSON.parse(await readFile("job.json", "utf8")) as ClientSessionState;
  const session = client.sessions.attach(saved.sessionId, { streamIndex: saved.streamIndex });
  if (command === "resume") {
    for await (const event of session.stream()) {
      if (event.type === "message.completed") console.log(event.data.message);
      if (event.type === "session.waiting") break;
    }
  } else {
    const response = await session.send(text ?? "Summarize the run.");
    console.log((await response.result()).message);
  }
  await writeFile("job.json", JSON.stringify(session.state));
}
