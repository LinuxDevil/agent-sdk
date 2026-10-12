/**
 * Eve audit repro: spec parsing edge cases + error messages.
 * Run: npx tsx audit/eve/repro-spec.ts
 */
import { resolveProvider } from '../../src/providers/resolveProvider';

const cases = [
  'openai/gpt-4o',
  'OpenAI/gpt-4o', // uppercase prefix
  'openai/', // empty model
  '/gpt-4o', // empty provider
  'openai', // no slash
  'openai /gpt-4o', // space in provider
  'google/gemini-2.5-flash', // unsupported common provider
  'gemini/gemini-2.5-flash',
  'lmstudio/qwen3-8b',
  'groq/llama-3.3-70b',
  'azure/gpt-4o',
  'bedrock/claude-sonnet',
  'mistral/mistral-large',
  'ollama', // missing model
  'pi', // missing nested spec
];

for (const spec of cases) {
  try {
    const p = resolveProvider(spec as string);
    console.log(`${JSON.stringify(spec)} -> OK provider=${p.name} defaultModel=${p.defaultModel}`);
  } catch (e) {
    console.log(`${JSON.stringify(spec)} -> ${(e as Error).name}: ${(e as Error).message.split('\n')[0]}`);
  }
}
