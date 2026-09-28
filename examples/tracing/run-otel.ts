/**
 * Runnable example: AgentExecutor.execute() wired to a real OpenTelemetry
 * NodeTracerProvider, using OTel's own ConsoleSpanExporter so the emitted
 * spans are visible without needing a real collector (LOU-E6).
 *
 * Run with:
 *   npm run example:tracing:otel
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  NodeTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { AgentExecutor } from '../../src/execution/AgentExecutor';
import { AgentBuilder } from '../../src/core';
import { AgentType } from '../../src/types';
import { ToolRegistry } from '../../src/tools';
import { LLMProvider, GenerateOptions, GenerateResult } from '../../src/providers';
import { createOtelExporter } from './otel-exporter';

/** Same tiny mock provider as run-console.ts, so this needs no API key. */
class MockProvider implements LLMProvider {
  readonly name = 'mock';
  private step = 0;

  async generate(_options: GenerateOptions): Promise<GenerateResult> {
    this.step++;
    if (this.step === 1) {
      return {
        text: '',
        finishReason: 'tool_calls',
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'getWeather', arguments: JSON.stringify({ city: 'Cairo' }) },
          },
        ],
      };
    }
    return {
      text: "It's sunny in Cairo.",
      finishReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 6, totalTokens: 26 },
    };
  }

  async stream(): Promise<never> {
    throw new Error('MockProvider does not support streaming in this example');
  }

  supportsTools(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return false;
  }

  async getModels(): Promise<string[]> {
    return ['mock-model'];
  }
}

async function main() {
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  provider.register();
  const tracer = provider.getTracer('loushy-tracing-example');

  const toolRegistry = new ToolRegistry();
  toolRegistry.register('getWeather', {
    displayName: 'Get Weather',
    tool: tool({
      description: 'Get the current weather for a city',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: 'sunny', tempC: 29 }),
    }),
  });

  const agent = AgentBuilder.create()
    .setType(AgentType.SmartAssistant)
    .setName('Weather Agent')
    .setPrompt('You are a helpful weather assistant.')
    .addTool('getWeather', { tool: 'getWeather', options: {} })
    .build();

  const exporter = createOtelExporter(tracer);

  const result = await AgentExecutor.execute({
    agent,
    input: "What's the weather in Cairo?",
    provider: new MockProvider(),
    toolRegistry,
    exporter,
  });

  console.log('\nFinal result:', result.text);

  await provider.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
