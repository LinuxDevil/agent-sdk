// CORE: model-string errors at createAgent() vs at send(). Run: npx tsx eve/core/r13-model-spec.ts (no API keys in env)
import { createAgent } from '@lousho/build-ai-agent';
for (const model of ['gpt-4o-mini', 'openai/gpt-4o-mini', 'opneai/gpt-4o-mini', undefined]) {
  let stage = 'createAgent';
  try {
    const agent = createAgent(model === undefined ? {} : { model });
    stage = 'send';
    await agent.send('hi');
    console.log('%j -> no error?!', model);
  } catch (e: any) {
    console.log('%j -> thrown at %s: %s %s', model, stage, e.code, String(e.message).split('\n')[0].slice(0, 160));
  }
}
