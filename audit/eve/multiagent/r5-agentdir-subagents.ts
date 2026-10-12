/* Eve multiagent repro 5: agent-directory sub-agents (`subagents/<name>/`) are wired as legacy
 * `delegate_to_<name>` tools that call `child.send()` - NOT through the native `task` runtime.
 * So none of the documented sub-agent inheritance applies: lead `permissions` deny rules, usage
 * roll-up, approvals, event forwarding, trace nesting.
 * Run: npx tsx eve/multiagent/r5-agentdir-subagents.ts */
import { deny, loadAgentDir } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import * as path from 'node:path';

const dir = path.join(import.meta.dirname, 'fixtures', 'lead-dir');
const u = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });
const model = mockModel([
  { toolCalls: [{ name: 'delegate_to_coder', args: { task: 'write a.txt then deploy' } }], usage: u(10, 1) }, // lead
  { toolCalls: [{ name: 'write_file', args: { path: 'a.txt' } }], usage: u(1000, 100) }, // coder
  { toolCalls: [{ name: 'deploy', args: {} }], usage: u(1000, 100) }, // coder -> pauses
  { text: 'lead done', usage: u(10, 1) }, // lead
]);
const events: string[] = [];
const spans: string[] = [];
const lead = await loadAgentDir(dir, {
  provider: model,
  // The lead forbids write_file for its whole tree (as a native sub-agent would inherit).
  permissions: [deny('write_file')],
  onEvent: (e: any) => events.push(`${e.type}${e.subagent ? `@${e.subagent.name}` : ''}`),
  exporter: { onSpanStart: () => {}, onSpanEnd: (s: any) => spans.push(`${s.name}${s.parentId ? '' : ' (ROOT)'}`) },
} as any);
const r = await lead.send('go');
const toolMsg = r.messages.find((m: any) => m.role === 'tool');
console.log('lead finishReason:', r.finishReason, '| approvalId:', r.approvalId ?? '(none)');
console.log('write_file executed despite lead deny rule:', JSON.stringify((globalThis as any).__eveWrites ?? []));
console.log('delegate result the lead model saw:', JSON.stringify(toolMsg?.content).slice(0, 220));
console.log('lead result.usage.inputTokens:', r.usage.inputTokens, '(child spent 2000) delegated:', JSON.stringify(r.usage.delegated));
console.log('subagent-tagged events:', events.filter((e) => e.includes('@')).length, 'of', events.length);
console.log('spans:', spans.join(' | '));
