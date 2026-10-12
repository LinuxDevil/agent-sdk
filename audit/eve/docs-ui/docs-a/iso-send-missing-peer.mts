// Run in a clean project OUTSIDE E:\agent-sdk (npm i <tgz> ai@7 zod@4 tsx).
import { createAgent, resolveProvider, MissingPeerDependencyError } from '@lousho/build-ai-agent';
process.env.ANTHROPIC_API_KEY = 'dummy'; process.env.OPENAI_API_KEY='dummy';
for (const spec of ['anthropic/claude-3-5-haiku-latest', 'openai/gpt-4o-mini']) {
  const r: any = await createAgent({ model: spec }).send('hi').catch((e) => e);
  console.log(spec, 'send():', r?.constructor?.name, r instanceof MissingPeerDependencyError, r.code, '|', String(r.message).slice(0, 250), '| cause:', r.cause?.constructor?.name, r.cause?.code, r.cause?.installCommand);
  const p = resolveProvider(spec);
  const r2: any = await p.generate({ messages: [{ role: 'user', content: 'hi' }] } as any).catch((e) => e);
  console.log(spec, 'generate():', r2 instanceof MissingPeerDependencyError, r2.code, r2.installCommand);
}
