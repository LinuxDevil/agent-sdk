// Lists the Hostinger MCP server's tools via connectMcp (no tool is called).
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { readHostingerToken } from '../token.js';

const token = readHostingerToken();
const command = process.argv[2] ?? 'npx';
const t0 = Date.now();
try {
  const mcp = await connectMcp(
    { hostinger: { command, args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'], env: { HOSTINGER_API_TOKEN: token } } },
    { logger: { debug() {}, info() {}, warn: (m: string) => console.log('WARN', m), error: (m: string) => console.log('ERR', m) } as any }
  );
  console.log(`connected via '${command}' in ${Date.now() - t0}ms, status=${JSON.stringify(mcp.status())}, tools=${Object.keys(mcp.tools).length}`);
  const rows = Object.values(mcp.tools).map((t: any) => ({
    name: t.name,
    ann: t.metadata?.mcp?.annotations,
    needsApproval: t.needsApproval,
  }));
  if (process.argv[3] === 'full') console.log(JSON.stringify(rows, null, 0));
  else for (const r of rows) console.log(r.name, JSON.stringify(r.ann ?? null), r.needsApproval);
  await mcp.close();
  console.log('closed');
} catch (e: any) {
  console.log(`FAILED via '${command}' after ${Date.now() - t0}ms: ${e?.name}: ${String(e?.message).replaceAll(token, '[REDACTED]')}`);
}
