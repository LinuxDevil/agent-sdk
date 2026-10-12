import { resolveProvider } from '../../src/providers/resolveProvider';
try {
  const p = resolveProvider('mock/anything');
  console.log('mock spec OK:', p.name, p.defaultModel);
} catch (e) { console.log('mock spec FAIL:', (e as Error).message.split('\n')[0]); }
try { resolveProvider('   '); } catch (e) { console.log('spaces spec:', (e as Error).message.slice(0,160)); }
try { resolveProvider('openai/gpt 4o'); } catch (e) { console.log('space in model:', (e as Error).message.slice(0,160)); }
process.env.OLLAMA_BASE_URL = '';
try { const p = resolveProvider('ollama/llama3.1'); console.log('ollama OK', p.defaultModel); } catch (e) { console.log('ollama:', (e as Error).message.slice(0,160)); }
