// MCP connection lifecycle on Windows: does close() reap the whole process tree?
// Only `search`/listTools are used; no Hostinger operation is executed.
// usage: tsx lifecycle.ts <npx|npx.cmd> <connectMcp|agent> [noclose]
import { execFileSync } from 'node:child_process';
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { createAgent } from '@lousho/build-ai-agent';
import { readHostingerToken } from '../token.js';
import { localProvider } from '../../../_shared/local.js';

const [command = 'npx', mode = 'connectMcp', noclose] = process.argv.slice(2);
const token = readHostingerToken();

export function mcpProcs(): string[] {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*hostinger-vps-mcp*' -or $_.CommandLine -like '*hostinger-api-mcp*' } | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }"], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).filter((l) => !l.includes('powershell'));
}

const server = { command, args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'], env: { HOSTINGER_API_TOKEN: token } };
console.log(`[${command}/${mode}] before:`, mcpProcs());
const t0 = Date.now();
if (mode === 'connectMcp') {
  const mcp = await connectMcp({ hostinger: server });
  console.log(`connected in ${Date.now() - t0}ms`, mcp.status());
  console.log('while connected:', mcpProcs());
  if (noclose) { console.log('exiting WITHOUT close()'); process.exit(0); }
  const tc = Date.now();
  await mcp.close();
  console.log(`close() took ${Date.now() - tc}ms`, mcp.status());
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after close:', mcpProcs());
  // lazy reconnect: a tool call after close() reconnects
  const r: any = await (mcp.tools['hostinger__search'] as any).execute({ query: 'list vps', limit: 1 }, {});
  console.log('search after close() (lazy reconnect) ok, chars=', JSON.stringify(r).length, mcp.status());
  console.log('after lazy reconnect:', mcpProcs());
  await mcp.close();
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after 2nd close:', mcpProcs());
} else {
  const agent = createAgent({ provider: localProvider(), instructions: 'x', mcpServers: { hostinger: server } });
  await agent.ready();
  console.log(`agent.ready() in ${Date.now() - t0}ms; while connected:`, mcpProcs());
  if (noclose) { console.log('exiting WITHOUT close()'); process.exit(0); }
  await agent.close();
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after agent.close():', mcpProcs());
  await agent.ready();
  console.log('after 2nd ready():', mcpProcs());
  await agent.close();
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after 2nd close():', mcpProcs());
}
