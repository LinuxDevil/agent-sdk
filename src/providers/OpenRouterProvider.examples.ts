/**
 * OpenRouter Provider Usage Examples
 * 
 * This file demonstrates how to use the OpenRouter provider
 */

import { LLMProviderRegistry, AgentBuilder, AgentType, Message } from '../index';

/**
 * Example 1: Basic text generation with OpenRouter
 */
export async function basicGeneration() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    defaultModel: 'openai/gpt-4o-mini',
  });

  const result = await provider.generate({
    model: 'openai/gpt-4o-mini',
    messages: [
      { role: 'user', content: 'What is the capital of France?' }
    ],
    temperature: 0.7,
    maxTokens: 100,
  });

  console.log('Response:', result.text);
  console.log('Tokens used:', result.usage.totalTokens);
  
  return result;
}

/**
 * Example 2: Streaming text generation
 */
export async function streamingGeneration() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
  });

  const stream = await provider.stream({
    model: 'anthropic/claude-3.5-sonnet',
    messages: [
      { role: 'user', content: 'Write a short story about a robot learning to paint.' }
    ],
    temperature: 0.8,
    maxTokens: 500,
  });

  console.log('Streaming response:');
  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk);
  }

  const usage = await stream.usage;
  console.log('\n\nTokens used:', usage.totalTokens);
}

/**
 * Example 3: Using different model providers
 */
export async function multiModelComparison() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
  });

  const question = 'Explain quantum computing in simple terms.';
  const models = [
    'openai/gpt-4o-mini',
    'anthropic/claude-3-haiku',
    'google/gemini-pro',
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
    console.log(`\nTokens: ${result.usage.totalTokens}`);
  }
}

/**
 * Example 4: Tool calling with OpenRouter
 */
export async function toolCallingExample() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
  });

  const result = await provider.generate({
    model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: 'What\'s the weather like in Paris and Tokyo?' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather information for a location',
          parameters: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'City name',
              },
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
    result.toolCalls.forEach(call => {
      console.log(`- ${call.function.name}(${call.function.arguments})`);
    });
  } else {
    console.log('No tool calls:', result.text);
  }

  return result;
}

/**
 * Example 5: Using OpenRouter with AgentBuilder
 */
export async function agentBuilderExample() {
  const agent = new AgentBuilder()
    .setType(AgentType.SmartAssistant)
    .setName('Travel Assistant')
    .setPrompt(`You are a helpful travel assistant. You provide information about destinations, 
      travel tips, and help plan trips. Be concise and informative.`)
    .setMetadata({
      provider: 'openrouter',
      providerConfig: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        defaultModel: 'anthropic/claude-3.5-sonnet',
        siteUrl: 'https://myapp.com',
        siteName: 'Travel App',
      }
    })
    .build();

  console.log('Agent created:', agent.name);
  
  // Note: execute method requires proper execution setup
  // This is just to show the configuration
}

/**
 * Example 6: Getting available models
 */
export async function listAvailableModels() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
  });

  const models = await provider.getModels();
  
  console.log('Available models:');
  console.log('OpenAI models:', models.filter(m => m.startsWith('openai/')).slice(0, 5));
  console.log('Anthropic models:', models.filter(m => m.startsWith('anthropic/')).slice(0, 5));
  console.log('Google models:', models.filter(m => m.startsWith('google/')).slice(0, 5));
  console.log('Meta models:', models.filter(m => m.startsWith('meta-llama/')).slice(0, 5));
  
  console.log(`\nTotal models available: ${models.length}`);
}

/**
 * Example 7: Cost-optimized generation
 */
export async function costOptimizedGeneration() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
  });

  // Use cheaper models for simple tasks
  const simpleTask = await provider.generate({
    model: 'openai/gpt-4o-mini', // Much cheaper than gpt-4o
    messages: [
      { role: 'user', content: 'Translate "Hello" to Spanish' }
    ],
    maxTokens: 10,
  });

  console.log('Simple task result:', simpleTask.text);
  console.log('Tokens used:', simpleTask.usage.totalTokens);

  // Use more powerful models for complex tasks
  const complexTask = await provider.generate({
    model: 'anthropic/claude-3.5-sonnet',
    messages: [
      { 
        role: 'user', 
        content: 'Analyze the economic implications of artificial intelligence on global labor markets' 
      }
    ],
    maxTokens: 1000,
  });

  console.log('\nComplex task result length:', complexTask.text.length);
  console.log('Tokens used:', complexTask.usage.totalTokens);
}

/**
 * Example 8: Error handling
 */
export async function errorHandlingExample() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: 'invalid-key',
  });

  try {
    const result = await provider.generate({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    console.log(result.text);
  } catch (error: any) {
    console.error('Error occurred:');
    
    if (error.message.includes('unauthorized') || error.message.includes('401')) {
      console.error('Invalid API key');
    } else if (error.message.includes('rate limit')) {
      console.error('Rate limit exceeded');
    } else if (error.message.includes('insufficient credits')) {
      console.error('Insufficient credits');
    } else {
      console.error('Unknown error:', error.message);
    }
  }
}

/**
 * Example 9: Conversation with context
 */
export async function conversationExample() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
  });

  const messages: Message[] = [
    { role: 'system', content: 'You are a helpful programming tutor.' },
    { role: 'user', content: 'What is recursion?' },
  ];

  // First response
  const response1 = await provider.generate({
    model: 'openai/gpt-4o-mini',
    messages,
  });

  console.log('Assistant:', response1.text);

  // Continue conversation
  messages.push({ role: 'assistant', content: response1.text });
  messages.push({ role: 'user', content: 'Can you give me an example in Python?' });

  const response2 = await provider.generate({
    model: 'openai/gpt-4o-mini',
    messages,
  });

  console.log('\nAssistant:', response2.text);
  console.log('\nTotal tokens used:', response2.usage.totalTokens);
}

/**
 * Example 10: Model capabilities check
 */
export async function modelCapabilitiesExample() {
  const provider = LLMProviderRegistry.create('openrouter', {
    apiKey: process.env.OPENROUTER_API_KEY || '',
  });

  const models = [
    'openai/gpt-4o',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-pro',
    'meta-llama/llama-3.1-8b-instruct',
  ];

  console.log('Model Capabilities:\n');

  models.forEach(model => {
    console.log(`${model}:`);
    console.log(`  - Supports tools: ${provider.supportsTools(model)}`);
    console.log(`  - Supports streaming: ${provider.supportsStreaming(model)}`);
  });
}

// Main function to run examples
async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('Please set OPENROUTER_API_KEY environment variable');
    console.log('Get your key at: https://openrouter.ai/keys');
    return;
  }

  console.log('OpenRouter Provider Examples\n');
  console.log('='.repeat(50));

  // Uncomment the examples you want to run:
  
  // await basicGeneration();
  // await streamingGeneration();
  // await multiModelComparison();
  // await toolCallingExample();
  // await agentBuilderExample();
  // await listAvailableModels();
  // await costOptimizedGeneration();
  // await errorHandlingExample();
  // await conversationExample();
  // await modelCapabilitiesExample();
}

// Export main for programmatic use
export { main };

