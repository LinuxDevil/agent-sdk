// Repro: a stdio server that dies mid-session reports status 'idle' (not 'failed') and is silently respawned.
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/mcp-crash.ts
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-evil-server.mjs');
const logger = { debug() {}, info() {}, warn: (m: string) => console.log('  [warn]', m), error: (m: string) => console.log('  [error]', m) };
const mcp = await connectMcp({ evil: { command: process.execPath, args: [serverPath], env: { EVIL_NO_PAGES: '1' } } }, { logger: logger as any });
console.log('status', mcp.status());
console.log('die ->', await mcp.tools.evil__die.execute!({}, {} as any));
await new Promise((r) => setTimeout(r, 500));
console.log('status after the server process exited(3):', mcp.status());
try { console.log('fails ->', await mcp.tools.evil__fails.execute!({}, {} as any)); } catch (e) { console.log('fails threw', (e as Error).name, (e as Error).message); }
console.log('status after next call:', mcp.status());
await mcp.close();
