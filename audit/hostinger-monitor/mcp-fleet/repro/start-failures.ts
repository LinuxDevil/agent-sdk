// How connectMcp / createAgent({ mcpServers }) report MCP servers that fail to start.
// A fake marker token is used: none of these reach the Hostinger API with a real token.
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../../_shared/local.js';

const MARK = 'FAKE-TOKEN-MARKER-7f3a';
const cases: Record<string, any> = {
  enoent: { command: 'does-not-exist-xyz', args: [] },
  badPackage: { command: 'npx', args: ['-y', '--package=hostinger-api-mcp-does-not-exist-zz@latest', 'nope'] },
  exitsImmediately: { command: 'node', args: ['-e', 'console.error("boom on stderr"); process.exit(3)'] },
  garbageStdout: { command: 'node', args: ['-e', 'console.log("hello not json"); setInterval(()=>{},1000)'] },
  hangs: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] },
};
const only = process.argv[2];
for (const [name, spec] of Object.entries(cases)) {
  if (only && only !== name) continue;
  const server = { ...spec, env: { HOSTINGER_API_TOKEN: MARK } };
  let t0 = Date.now();
  try {
    const mcp = await connectMcp({ hostinger: server });
    console.log(`[${name}] connectMcp RESOLVED?! status=${JSON.stringify(mcp.status())}`);
    await mcp.close();
  } catch (e: any) {
    const msg = String(e?.message);
    console.log(`[${name}] connectMcp rejected after ${Date.now() - t0}ms: ${e?.name}: ${msg.slice(0, 300)} | code=${e?.code} | cause=${e?.cause?.code ?? e?.cause?.name} | leaksToken=${JSON.stringify(e).includes(MARK) || msg.includes(MARK) || String(e?.stack).includes(MARK)}`);
  }
  if (name === 'hangs' || name === 'garbageStdout') continue; // createAgent path takes the same route
  t0 = Date.now();
  const agent = createAgent({ provider: localProvider(), instructions: 'x', mcpServers: { hostinger: server } });
  try {
    const r = await agent.send('hi');
    console.log(`[${name}] agent.send resolved finishReason=${r.finishReason} error=${(r as any).error?.message}`);
  } catch (e: any) {
    console.log(`[${name}] agent.send rejected after ${Date.now() - t0}ms: ${e?.name}: ${String(e?.message).slice(0, 300)} | code=${e?.code} | leaksToken=${String(e?.stack).includes(MARK) || JSON.stringify(e).includes(MARK)}`);
  }
  await agent.close();
}
