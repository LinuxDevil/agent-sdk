// Calls ONLY read-only GET operations (allowlisted) to measure payload sizes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readHostingerToken } from '../token.js';
const RO = new Set(['vps_virtual-machines_list', 'vps_virtual-machines_metrics', 'vps_actions_list', 'vps_backups_list', 'vps_firewall_list']);
const token = readHostingerToken();
const client = new Client({ name: 'probe', version: '1' });
await client.connect(new StdioClientTransport({ command: 'npx', args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'], env: { ...process.env as any, HOSTINGER_API_TOKEN: token }, stderr: 'pipe' }));
async function ro(operation: string, params: any = {}) {
  if (!RO.has(operation)) throw new Error('blocked ' + operation);
  const r: any = await client.callTool({ name: 'execute', arguments: { operation, params } });
  return r;
}
const list = await ro('vps_virtual-machines_list');
const text = list.content[0].text;
console.log('list chars', JSON.stringify(list).length, 'isError', list.isError, 'structured?', !!list.structuredContent);
const vms = JSON.parse(text);
console.log('vm count', Array.isArray(vms) ? vms.length : typeof vms, 'keys', Object.keys(Array.isArray(vms) ? vms[0] : vms));
const vm = (Array.isArray(vms) ? vms : vms.data)[0];
console.log('first vm summary', JSON.stringify({ id: vm.id, state: vm.state, plan: vm.plan, cpus: vm.cpus, memory: vm.memory, disk: vm.disk, bandwidth: vm.bandwidth, template: vm.template?.name, ipv4: vm.ipv4?.length }));
const to = new Date(); const from = new Date(to.getTime() - 6 * 3600e3);
const m = await ro('vps_virtual-machines_metrics', { virtualMachineId: vm.id, date_from: from.toISOString(), date_to: to.toISOString() });
console.log('metrics chars', JSON.stringify(m).length, 'isError', m.isError);
console.log(m.content[0].text.slice(0, 700));
const a = await ro('vps_actions_list', { virtualMachineId: vm.id });
console.log('actions chars', JSON.stringify(a).length, a.content[0].text.slice(0, 400));
const b = await ro('vps_backups_list', { virtualMachineId: vm.id });
console.log('backups chars', JSON.stringify(b).length, b.content[0].text.slice(0, 400));
await client.close();
