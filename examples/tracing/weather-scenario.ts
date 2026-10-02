/**
 * Shared scenario for the tracing examples (run-console.ts, run-otel.ts):
 * a weather agent backed by a scripted mock provider, so neither example
 * needs network access or an API key. Only the TraceExporter differs
 * between the two examples.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { AgentExecutor } from '../../src/execution/AgentExecutor';
import { AgentBuilder } from '../../src/core';
import { ToolRegistry } from '../../src/tools';
import { LLMProvider, GenerateOptions, GenerateResult } from '../../src/providers';
import type { TraceExporter } from '../../src/execution/tracing';

/** A tiny mock provider: one tool call, then a final answer. */
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

function createWeatherToolRegistry(): ToolRegistry {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register('getWeather', {
    displayName: 'Get Weather',
    tool: tool({
      description: 'Get the current weather for a city',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: 'sunny', tempC: 29 }),
    }),
  });
  return toolRegistry;
}

function createWeatherAgent() {
  return AgentBuilder.create()
    .setName('Weather Agent')
    .setPrompt('You are a helpful weather assistant.')
    // A priced model id, so spans carry `lousho.cost_usd` (the provider is still a mock).
    .setSettings({ model: 'gpt-4o-mini' })
    .addTool('getWeather', { tool: 'getWeather', options: {} })
    .build();
}

/** Runs the weather agent once with `exporter` attached and prints the final answer. */
export async function runWeatherScenario(exporter: TraceExporter): Promise<void> {
  const result = await AgentExecutor.execute({
    agent: createWeatherAgent(),
    input: "What's the weather in Cairo?",
    provider: new MockProvider(),
    toolRegistry: createWeatherToolRegistry(),
    exporter,
  });

  console.log('\nFinal result:', result.text);
}
