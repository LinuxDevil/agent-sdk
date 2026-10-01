// (a) Tool-using chat agent: one zod tool, streaming to stdout.
import { Agent } from "@openharness/core";
import { openai } from "@ai-sdk/openai";
import { tool } from "ai";
import { z } from "zod";

const getWeather = tool({
  description: "Return mock weather data for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  execute: async ({ city }) => ({ city, condition: "Sunny", temperatureF: 72 }),
});

const agent = new Agent({
  name: "weather",
  model: openai("gpt-5.4"),
  systemPrompt: "You are a concise weather assistant. Say the data is mocked.",
  tools: { get_weather: getWeather },
});

for await (const event of agent.run([], process.argv[2] ?? "What is the weather in Paris?")) {
  if (event.type === "text.delta") process.stdout.write(event.text);
}
process.stdout.write("\n");
