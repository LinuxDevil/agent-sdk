import { createAgent } from '@lousho/build-ai-agent';
process.env.OPENROUTER_API_KEY = 'sk-or-fake'; process.env.ANTHROPIC_API_KEY = 'sk-ant-fake'; process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1/v1';
for (const model of ['pi/openrouter/openai/gpt-4o-mini', 'anthropic/claude-haiku-4-5', 'ollama/llama3.1']) {
  try {
    const r = await createAgent({ model, retry: false }).send('hi');
    console.log(model, 'resolved?', r.text);
  } catch (e: any) { console.log(model, '->', e.name, e.code, String(e.message).split('\n')[0].slice(0, 260)); }
}
