/**
 * agent-dir - an agent defined as a directory (LOU-Y5).
 *
 * `loadAgentDir()` reads instructions.md, tools/, skills/ and agent.json from
 * this folder and returns the same object `createAgent()` does. The model is
 * overridden with a scripted `mockModel`, so this runs offline with no API key.
 *
 * Loading a directory executes its code (tools/*.ts), so only load directories
 * you trust. Run with: npx tsx examples/agent-dir/index.ts
 */
import path from 'node:path';
import { loadAgentDir } from '../../src';
import { mockModel } from '../../src/testing';

const provider = mockModel([
  {
    toolCalls: [
      { name: 'word_count', args: { text: 'This is a very simple sentence.' } },
      { name: 'load_skill', args: { name: 'tone' } },
    ],
  },
  'It has 6 words. Try: "This is a simple sentence."',
]);

async function main() {
  const agent = await loadAgentDir(path.join(__dirname), { provider });
  const result = await agent.send('Check this: "This is a very simple sentence."');
  console.log(result.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
