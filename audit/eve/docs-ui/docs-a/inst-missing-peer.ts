import { MissingPeerDependencyError, resolveProvider, createAgent } from '@lousho/build-ai-agent';
for (const k of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','LOUSHO_MODEL']) delete process.env[k];
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9';
const provider = resolveProvider('ollama/llama3.2');
try { await provider.generate({ messages: [{ role: 'user', content: 'hello' }] } as any); console.log('no throw'); }
catch (e: any) { console.log('ollama:', e instanceof MissingPeerDependencyError, e.name, e.code, '| pkg', e.packageName, '| cmd', e.installCommand, '|', String(e.message).slice(0, 200)); }
try { const { createOtelTraceExporter } = await import('@lousho/build-ai-agent/otel'); const ex = await (createOtelTraceExporter as any)(); console.log('otel no throw', typeof ex); }
catch (e: any) { console.log('otel:', e instanceof MissingPeerDependencyError, e.code, '|', String(e.message).slice(0, 220)); }
