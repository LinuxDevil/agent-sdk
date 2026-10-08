// Token-leak probe: createAgent({ mcpServers }) with a FAKE marker token; a read-only GET fails with 401.
// Scans traces (captureContent), events, results, errors, permission audit and the agent object for the marker.
import { createAgent, type Span } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const MARK = 'FAKE-TOKEN-MARKER-9c1d';
const sink: string[] = [];
const agent = createAgent({
  provider: mockModel([
    { toolCalls: [{ name: 'hostinger__search', args: { query: 'list vps', limit: 1 } }, { name: 'hostinger__execute', args: { operation: 'vps_virtual-machines_list' } }] },
    { text: 'done' },
  ]),
  instructions: 'x',
  mcpServers: { hostinger: { command: 'npx', args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'], env: { HOSTINGER_API_TOKEN: MARK }, approval: 'never' } },
  exporter: { onSpanStart: (s: Span) => sink.push(JSON.stringify(s)), onSpanEnd: (s: Span) => sink.push(JSON.stringify(s)) },
  captureContent: true,
  onEvent: (e) => sink.push(JSON.stringify(e)),
  onPermissionDecision: (e) => sink.push(JSON.stringify(e)),
});
const r = await agent.send('go');
sink.push(JSON.stringify(r));
const execMsg: any = r.messages.find((m: any) => m.role === 'tool' && m.toolName === 'hostinger__execute');
console.log('execute (fake token) tool message:', String(execMsg?.content).slice(0, 300));
let agentDump = '';
try { agentDump = JSON.stringify(agent); } catch (e) { agentDump = String(e); }
console.log('marker in traces/events/result/audit:', sink.some((s) => s.includes(MARK)), `(${sink.length} records)`);
console.log('marker reachable via JSON.stringify(agent):', agentDump.includes(MARK));
console.log('marker reachable via (agent as any).config?.mcpServers:', JSON.stringify((agent as any).config ?? (agent as any).mcpServers ?? null).includes(MARK));
await agent.close();
