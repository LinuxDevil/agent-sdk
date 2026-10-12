// memory.md:24-51 — the French preference example, live (3-4 calls)
import { LIVE_MODEL } from '../../../_shared/env.ts';
import { createAgent, defineMemory, fileMemory } from '@lousho/build-ai-agent';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.cwd(), 'eve/docs-ui/docs-a/.tmp-mem'); rmSync(dir, { recursive: true, force: true });
const preferences = defineMemory({ name: 'preferences', description: "the user's preferences: language, tone, tools they like", scope: 'session', provider: fileMemory({ dir }) });
const agent = createAgent({ model: LIVE_MODEL, instructions: 'You are a helpful assistant. Save lasting preferences with remember_preferences.', memory: [preferences] });
const r1 = await agent.session({ id: 'user-42' }).send('Please always answer in French.');
console.log('turn1 tools called:', r1.toolCalls.map((c: any) => c.function.name), '| text:', r1.text.slice(0, 80));
console.log('files:', readdirSync(dir), readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8').slice(0, 200)));
const { text } = await agent.session({ id: 'user-42' }).send('What is the capital of Japan?');
console.log('turn2:', text);
