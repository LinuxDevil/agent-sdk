/**
 * openrouter - runnable snippets showing OpenRouterProvider usage (LOU-B6).
 *
 * Requires OPENROUTER_API_KEY (get one at https://openrouter.ai/keys). Pick a
 * snippet by name, or run them all with no argument.
 *
 * Run with: tsx examples/openrouter/index.ts [snippet]
 *   snippets: basic, streaming, compare, tools, agent-builder, models,
 *             cost, errors, conversation, capabilities
 */
import { LLMProviderRegistry, Message } from '../../src/index';
import { AgentBuilder } from '../../src/executor';

const apiKey = process.env.OPENROUTER_API_KEY || '';

function createProvider(config: { defaultModel?: string; apiKey?: string } = {}) {
  return LLMProviderRegistry.create('openrouter', { apiKey, ...config });
}

/** Basic text generation. */
async function basicGeneration() {
  const provider = createProvider({ defaultModel: 'openai/gpt-4o-mini' });

  const result = await provider.generate({
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    temperature: 0.7,
    maxTokens: 100,
  });

  console.log('Response:', result.text);
  console.log('Tokens used:', result.usage?.totalTokens);
}

/** Streaming text generation. */
async function streamingGeneration() {
  const provider = createProvider();

  const stream = await provider.stream({
    model: 'anthropic/claude-sonnet-4',
    messages: [
      { role: 'user', content: 'Write a short story about a robot learning to paint.' },
    ],
    temperature: 0.8,
    maxTokens: 500,
  });

  console.log('Streaming response:');
  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk);
  }

  const usage = await stream.usage;
  console.log('\n\nTokens used:', usage?.totalTokens);
}

/** Using different model providers behind the one OpenRouter key. */
async function multiModelComparison() {
  const provider = createProvider();

  const question = 'Explain quantum computing in simple terms.';
  const models = [
    'openai/gpt-4o-mini',
    'anthropic/claude-haiku-4.5',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.1-8b-instruct',
  ];

  console.log('Comparing responses from different models:\n');

  for (const model of models) {
    console.log(`\n${model}:`);
    console.log('-'.repeat(50));

    const result = await provider.generate({
      model,
      messages: [{ role: 'user', content: question }],
      maxTokens: 200,
    });

    console.log(result.text);
    console.log(`\nTokens: ${result.usage?.totalTokens}`);
  }
}

/** Tool calling. */
async function toolCalling() {
  const provider = createProvider();

  const result = await provider.generate({
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: "What's the weather like in Paris and Tokyo?" }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather information for a location',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' },
              unit: {
                type: 'string',
                enum: ['celsius', 'fahrenheit'],
                description: 'Temperature unit',
              },
            },
            required: ['location'],
          },
        },
      },
    ],
  });

  if (result.toolCalls && result.toolCalls.length > 0) {
    console.log('Tool calls requested:');
    result.toolCalls.forEach((call) => {
      console.log(`- ${call.function.name}(${call.function.arguments})`);
    });
  } else {
    console.log('No tool calls:', result.text);
  }
}

/** Configuring an agent to use OpenRouter via AgentBuilder, then running its prompt through that provider. */
async function agentBuilder() {
  const providerConfig = {
    apiKey,
    defaultModel: 'anthropic/claude-sonnet-4',
    siteUrl: 'https://myapp.com',
    siteName: 'Travel App',
  };
  const provider = createProvider(providerConfig);

  const agent = new AgentBuilder()
    .setName('Travel Assistant')
    .setPrompt(`You are a helpful travel assistant. You provide information about destinations,
      travel tips, and help plan trips. Be concise and informative.`)
    .setMetadata({
      provider: 'openrouter',
      providerConfig,
    })
    .build();

  console.log('Agent created:', agent.name);

  // The built agent's system prompt drives a real call through the provider above.
  const result = await provider.generate({
    model: providerConfig.defaultModel,
    messages: [
      { role: 'system', content: agent.prompt! },
      { role: 'user', content: 'Suggest one weekend city break from Paris.' },
    ],
    maxTokens: 120,
  });
  console.log('Agent says:', result.text);
}

/** Getting available models. */
async function listAvailableModels() {
  const provider = createProvider();

  const models = await provider.getModels();

  console.log('Available models:');
  for (const [label, prefix] of [
    ['OpenAI', 'openai/'],
    ['Anthropic', 'anthropic/'],
    ['Google', 'google/'],
    ['Meta', 'meta-llama/'],
  ]) {
    console.log(`${label} models:`, models.filter((m) => m.startsWith(prefix)).slice(0, 5));
  }

  console.log(`\nTotal models available: ${models.length}`);
}

/** Cost-optimized generation: cheap models for simple tasks, strong ones for hard tasks. */
async function costOptimizedGeneration() {
  const provider = createProvider();

  const simpleTask = await provider.generate({
    model: 'openai/gpt-4o-mini', // Much cheaper than gpt-4o
    messages: [{ role: 'user', content: 'Translate "Hello" to Spanish' }],
    maxTokens: 10,
  });

  console.log('Simple task result:', simpleTask.text);
  console.log('Tokens used:', simpleTask.usage?.totalTokens);

  const complexTask = await provider.generate({
    model: 'anthropic/claude-sonnet-4',
    messages: [
      {
        role: 'user',
        content:
          'Analyze the economic implications of artificial intelligence on global labor markets',
      },
    ],
    maxTokens: 1000,
  });

  console.log('\nComplex task result length:', complexTask.text.length);
  console.log('Tokens used:', complexTask.usage?.totalTokens);
}

/** Maps a provider error message to a friendly description. */
const ERROR_DESCRIPTIONS: Array<{ matches: string[]; description: string }> = [
  { matches: ['unauthorized', '401'], description: 'Invalid API key' },
  { matches: ['rate limit'], description: 'Rate limit exceeded' },
  { matches: ['insufficient credits'], description: 'Insufficient credits' },
];

function describeError(error: unknown): string {
  const e = error as { message?: string; name?: string; statusCode?: number };
  // Match on the whole error surface, not just message: the AI SDK's
  // APICallError carries the HTTP status in statusCode/name and can have an
  // empty message.
  const haystack = `${e?.name ?? ''} ${e?.statusCode ?? ''} ${e?.message ?? String(error)}`.toLowerCase();
  const known = ERROR_DESCRIPTIONS.find((entry) =>
    entry.matches.some((needle) => haystack.includes(needle)),
  );
  return known ? known.description : `Unknown error: ${e?.message || String(error)}`;
}

/** Error handling, using a deliberately invalid key. */
async function errorHandling() {
  const provider = createProvider({ apiKey: 'invalid-key' });

  try {
    const result = await provider.generate({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    console.log(result.text);
  } catch (error: unknown) {
    console.error('Error occurred:');
    console.error(describeError(error));
  }
}

/** Multi-turn conversation with context. */
async function conversation() {
  const provider = createProvider();

  const messages: Message[] = [
    { role: 'system', content: 'You are a helpful programming tutor.' },
    { role: 'user', content: 'What is recursion?' },
  ];

  const response1 = await provider.generate({ model: 'openai/gpt-4o-mini', messages });
  console.log('Assistant:', response1.text);

  messages.push({ role: 'assistant', content: response1.text });
  messages.push({ role: 'user', content: 'Can you give me an example in Python?' });

  const response2 = await provider.generate({ model: 'openai/gpt-4o-mini', messages });
  console.log('\nAssistant:', response2.text);
  console.log('\nTotal tokens used:', response2.usage?.totalTokens);
}

/** Model capabilities check. */
async function modelCapabilities() {
  const provider = createProvider();

  const models = [
    'openai/gpt-4o',
    'anthropic/claude-sonnet-4',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.1-8b-instruct',
  ];

  console.log('Model Capabilities:\n');

  models.forEach((model) => {
    console.log(`${model}:`);
    console.log(`  - Supports tools: ${provider.supportsTools(model)}`);
    console.log(`  - Supports streaming: ${provider.supportsStreaming(model)}`);
  });
}

const SNIPPETS: Record<string, () => Promise<void>> = {
  basic: basicGeneration,
  streaming: streamingGeneration,
  compare: multiModelComparison,
  tools: toolCalling,
  'agent-builder': agentBuilder,
  models: listAvailableModels,
  cost: costOptimizedGeneration,
  errors: errorHandling,
  conversation,
  capabilities: modelCapabilities,
};

/** Resolves the snippet names to run: the requested one, or all of them. */
function selectSnippets(requested: string | undefined): string[] {
  return requested ? [requested] : Object.keys(SNIPPETS);
}

async function runSnippet(name: string): Promise<void> {
  const snippet = SNIPPETS[name];
  if (!snippet) {
    throw new Error(`Unknown snippet "${name}". Choose from: ${Object.keys(SNIPPETS).join(', ')}`);
  }
  console.log(`\n=== ${name} ===`);
  await snippet();
}

async function main() {
  if (!apiKey) {
    console.log('Please set OPENROUTER_API_KEY environment variable');
    console.log('Get your key at: https://openrouter.ai/keys');
    return;
  }

  for (const name of selectSnippets(process.argv[2])) {
    await runSnippet(name);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
