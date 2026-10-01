// (a) Tool-using chat agent, streamed to stdout from a program.
// The agent lives in ./chat/agent/ (instructions.md, agent.ts, tools/get_weather.ts).
// `eve dev` alone already streams to the terminal UI; this script is the
// programmatic equivalent and needs the server running: `eve dev --no-ui`.
import { Client } from "eve/client";

const client = new Client({ host: "http://127.0.0.1:2000" });
const { response } = await client.sessions.create({
  message: process.argv[2] ?? "What is the weather in Paris?",
});
for await (const event of response) {
  if (event.type === "message.appended") process.stdout.write(event.data.messageDelta);
}
process.stdout.write("\n");
