// Repro: one JSON line that parses to null kills serveAcp (and the whole `lousho acp` process).
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/acp-null-line.ts
import { createAgent, serveAcp } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

async function run(lines: string[]) {
  const out: string[] = [];
  const agent = createAgent({ provider: mockModel(['hi', 'hi', 'hi']) });
  async function* input() {
    for (const l of lines) yield l;
  }
  try {
    await serveAcp(agent, { input: input(), write: (l) => out.push(l) });
    console.log('  resolved; replies:', out.map((l) => l.slice(0, 110)));
  } catch (e) {
    console.log('  serveAcp REJECTED:', (e as Error).name, (e as Error).message, '| replies so far:', out.length);
  }
}

const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
const after = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '.', mcpServers: [] } });
for (const bad of ['null', '[]', '"str"', '{"jsonrpc":"2.0","id":3,"method":"session/new","params":null}']) {
  console.log(`line ${bad}:`);
  await run([init, bad, after]);
}
