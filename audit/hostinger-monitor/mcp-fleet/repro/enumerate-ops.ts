// Enumerates the Hostinger API operations via the READ-ONLY `search` tool only.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readHostingerToken } from '../token.js';
const token = readHostingerToken();
const client = new Client({ name: 'probe', version: '1' });
await client.connect(new StdioClientTransport({ command: 'npx', args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'], env: { ...process.env as any, HOSTINGER_API_TOKEN: token }, stderr: 'pipe' }));
const ops = new Map<string, any>();
for (const q of ['vps', 'virtual machine', 'metrics', 'actions', 'backups', 'firewall', 'snapshot', 'ssh key', 'public key', 'template', 'data center', 'post install script', 'malware monarx', 'docker project', 'ptr', 'hostname', 'password', 'start stop restart', 'recovery', 'purchase', 'list', 'get', 'delete', 'create', 'update', 'nameservers', 'panel', 'attach', 'restore', 'billing', 'catalog', 'payment']) {
  const r: any = await client.callTool({ name: 'search', arguments: { query: q, limit: 20 } });
  let arr: any[] = []; try { arr = JSON.parse(r.content[0].text); } catch { continue; }
  for (const op of arr) ops.set(op.operation, op);
}
const rows = [...ops.values()].sort((a, b) => a.operation.localeCompare(b.operation));
for (const o of rows) console.log(`${o.readOnly ? 'RO ' : 'RW '}${o.destructive ? 'D ' : '  '}${o.operation}  req=${JSON.stringify(o.inputSchema?.required ?? [])}`);
console.log('total', rows.length);
await client.close();
