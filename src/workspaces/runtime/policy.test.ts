import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { narrowPolicy, type EffectivePolicy, type WorkspacePolicy } from '../contracts/policy';
import { checkPermission, type PermissionDecisionEntry, type PermissionRule } from '../../execution/permissions';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import { FlowExecutor } from '../../flows/FlowExecutor';
import { MockLLMProvider } from '../../providers/mock';
import { defineTool } from '../../tools/defineTool';
import type { SDKError } from '../../utils/sdkError';
import type { AgentOwned } from './agentDirView';
import { agentPolicyOptions, effectivePermissions, effectiveToolset, pagePolicy, type HostToolRegistry } from './policy';

const tool = (name: string, execute = vi.fn(async () => `${name} ran`)) => defineTool({ name, description: `The ${name} tool`, input: z.object({ value: z.string().optional() }), execute });

function registry(names: readonly string[], extra: Partial<Record<string, Omit<HostToolRegistry[string], 'descriptor'>>> = {}): HostToolRegistry {
  return Object.fromEntries(names.map((name) => [name, { descriptor: tool(name), ...extra[name] }]));
}

const base: WorkspacePolicy = { permissions: [], tools: { allow: ['*'] }, secrets: [] };

const effective = (workspace: Partial<WorkspacePolicy>, ceiling: Partial<WorkspacePolicy> = {}): EffectivePolicy => narrowPolicy({ ...base, ...ceiling }, { ...base, ...workspace });

const names = (set: { tools: readonly { name: string }[] }): string[] => set.tools.map((entry) => entry.name);

async function decide(rules: readonly PermissionRule[], toolName: string): Promise<string | undefined> {
  return (await checkPermission({ permissions: rules }, { toolName, toolCallId: 'call-1', args: {} }))?.decision;
}

function agent(owned: Partial<AgentOwned>): AgentOwned {
  return { name: 'writer', skills: [], tools: [], toolFiles: [], memory: [], ...owned };
}

describe('effectiveToolset', () => {
  it('a tool outside the allowlist is absent even if the agent defines it', () => {
    const set = effectiveToolset(effective({ tools: { allow: ['search_facts'] } }), undefined, ['search_facts', 'shell'], registry(['search_facts', 'shell']));
    expect(names(set)).toEqual(['search_facts']);
  });

  it('a tool the workspace allows but the host ceiling does not is absent', () => {
    const policy = effective({ tools: { allow: ['search_facts', 'publish'] } }, { tools: { allow: ['search_*'] } });
    const set = effectiveToolset(policy, undefined, ['search_facts', 'publish'], registry(['search_facts', 'publish']));
    expect(names(set)).toEqual(['search_facts']);
  });

  it('tools.only narrows', () => {
    const set = effectiveToolset(effective({}), { tools: { only: ['render_video'] } }, ['render_video', 'search_facts'], registry(['render_video', 'search_facts']));
    expect(names(set)).toEqual(['render_video']);
  });

  it('tools.only never adds a tool the agent does not define, and a pattern in it is a literal name', () => {
    const set = effectiveToolset(effective({}), { tools: { only: ['render_video', 'shell', '*'] } }, ['render_video'], registry(['render_video', 'shell']));
    expect(names(set)).toEqual(['render_video']);
    expect(names(effectiveToolset(effective({}), { tools: { only: ['*'] } }, ['shell'], registry(['shell'])))).toEqual([]);
  });

  it('takes tools only from the host registry, and reports an agent tool file the registry lacks', () => {
    const set = effectiveToolset(effective({}), undefined, ['web', '__proto__', 'constructor', 'search_facts'], registry(['search_facts', 'web_fetch']));
    expect(names(set)).toEqual(['search_facts']);
    expect(set.missing).toEqual(['web', '__proto__', 'constructor']);
  });

  it('exposes only policy secrets, and only to the tools that declare them', () => {
    const host = registry(['publish', 'search_facts'], { publish: { secrets: [{ env: 'API_KEY' }, { env: 'OTHER_KEY' }] } });
    const policy = effective({ secrets: [{ env: 'API_KEY' }, { env: 'OTHER_KEY' }] }, { secrets: [{ env: 'API_KEY' }] });
    const set = effectiveToolset(policy, undefined, ['publish', 'search_facts'], host);
    expect(set.tools.map(({ name, secrets }) => ({ name, secrets }))).toEqual([
      { name: 'publish', secrets: [{ env: 'API_KEY' }] },
      { name: 'search_facts', secrets: [] },
    ]);
  });
});

describe('effectivePermissions', () => {
  it('a policy deny beats an agent allow', async () => {
    const policy = effective({ permissions: [{ id: 'no-shell', tool: 'shell', action: 'deny', reason: 'No shell' }] });
    const { rules, warnings } = effectivePermissions(policy, [{ tool: 'shell', action: 'allow' }]);
    expect(await decide(rules, 'shell')).toBe('deny');
    expect(warnings).toEqual([expect.stringContaining("allows 'shell'")]);
    const listed = effective({ permissions: [{ id: 'no-exec', tool: ['exec', 'shell'], action: 'ask' }] });
    expect(effectivePermissions(listed, [{ tool: ['shell', 'search'], action: 'allow' }]).warnings).toEqual([expect.stringContaining("allows 'shell'")]);
    expect(effectivePermissions(policy, [{ tool: '*', action: 'allow' }]).warnings).toEqual([expect.stringContaining("allows '*'")]);
  });

  it('a ceiling deny and a policy ask beat an agent allow, and an agent deny or ask holds under a ceiling allow', async () => {
    const policy = effective(
      { permissions: [{ id: 'ask-publish', tool: 'publish', action: 'ask' }] },
      { permissions: [{ id: 'no-delete', tool: 'delete_*', action: 'deny' }, { id: 'all', tool: '*', action: 'allow' }] }
    );
    const { rules } = effectivePermissions(policy, [
      { tool: 'shell', action: 'deny' },
      { tool: 'render', action: 'ask' },
      { tool: '*', action: 'allow' },
    ]);
    expect(await decide(rules, 'delete_post')).toBe('deny');
    expect(await decide(rules, 'publish')).toBe('ask');
    expect(await decide(rules, 'shell')).toBe('deny');
    expect(await decide(rules, 'render')).toBe('ask');
    expect(await decide(rules, 'search')).toBe('allow');
  });

  it('a workspace allow is dropped and a ceiling allow alone grants nothing', async () => {
    const policy = effective({ permissions: [{ id: 'all', tool: '*', action: 'allow' }] }, { permissions: [{ id: 'all', tool: '*', action: 'allow' }] });
    expect(await decide(effectivePermissions(policy, undefined).rules, 'shell')).toBe('default');
  });

  it("keeps the deciding rule's reason and ttl", async () => {
    const policy = effective({ permissions: [{ id: 'ask', tool: 'publish', action: 'ask', ttlMs: 60_000 }, { id: 'deny', tool: 'shell', action: 'deny', reason: 'No shell' }] });
    const { rules } = effectivePermissions(policy, []);
    const shell = await checkPermission({ permissions: rules }, { toolName: 'shell', toolCallId: 'c', args: {} });
    const publish = await checkPermission({ permissions: rules }, { toolName: 'publish', toolCallId: 'c', args: {} });
    expect(shell?.rule?.reason).toBe('No shell');
    expect(rules[publish?.rule?.index ?? -1]?.ttlMs).toBe(60_000);
  });
});

describe('agentPolicyOptions', () => {
  it('a required approval fires inside a workflow tool step', async () => {
    const execute = vi.fn(async () => 'published');
    const host: HostToolRegistry = { publish: { descriptor: tool('publish', execute) } };
    const policy = effective({ approvals: { require: ['publish'] } });
    const options = agentPolicyOptions(policy, { agent: agent({ tools: ['publish'], permissions: [{ tool: 'publish', action: 'allow' }] }) }, host);
    const approve = vi.fn(() => true);
    const context = {
      agent: { id: 'writer', name: 'writer', prompt: 'Write.', settings: { model: 'mock' } },
      provider: new MockLLMProvider({ name: 'mock', responses: [] }),
      variables: {},
      toolRegistry: options.toolRegistry,
      permissions: options.permissions,
      permissionMode: 'acceptEdits' as const,
    };
    const flow = { code: 'publish-flow', name: 'Publish', flow: { type: 'toolCall' as const, tool: 'publish', arguments: { value: 'post' } } };

    const refused = await FlowExecutor.execute(flow, context);
    expect(refused.success).toBe(false);
    expect((refused.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
    expect(execute).not.toHaveBeenCalled();

    const approved = await FlowExecutor.execute(flow, { ...context, approve });
    expect(approved.success).toBe(true);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'publish' }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("an agent allow never lifts a host tool's own needsApproval", async () => {
    const execute = vi.fn(async () => 'deleted');
    const host: HostToolRegistry = { delete_post: { descriptor: { ...tool('delete_post', execute), needsApproval: true } } };
    const options = agentPolicyOptions(effective({}), { agent: agent({ tools: ['delete_post'], permissions: [{ tool: 'delete_post', action: 'allow' }] }) }, host);
    const result = await FlowExecutor.execute(
      { code: 'f', name: 'f', flow: { type: 'toolCall', tool: 'delete_post', arguments: {} } },
      { agent: { id: 'a', name: 'a', prompt: 'p', settings: { model: 'mock' } }, provider: new MockLLMProvider({ name: 'mock', responses: [] }), variables: {}, toolRegistry: options.toolRegistry, permissions: options.permissions }
    );
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('the audit says which policy forced the ask', async () => {
    const host: HostToolRegistry = { delete_post: { descriptor: { ...tool('delete_post'), needsApproval: true } }, publish: { descriptor: tool('publish') } };
    const options = agentPolicyOptions(effective({ approvals: { require: ['publish'] } }), { agent: agent({ tools: ['delete_post', 'publish'], permissions: [{ tool: '*', action: 'allow' }] }) }, host);
    const audit: PermissionDecisionEntry[] = [];
    const model = mockModel([{ toolCalls: [{ name: 'delete_post', args: {} }, { name: 'publish', args: {} }] }]);
    const run = createAgent({ provider: model, tools: options.tools, permissions: options.permissions, onPermissionDecision: (entry) => audit.push(entry) });
    expect((await run.send('go')).finishReason).toBe('awaiting-approval');
    expect(audit).toEqual([
      expect.objectContaining({ toolName: 'delete_post', decision: 'ask', reason: expect.stringContaining("the tool's own needsApproval") }),
      expect.objectContaining({ toolName: 'publish', decision: 'ask', reason: expect.stringContaining('approvals.require') }),
    ]);
  });

  it("an agent's approval always makes every call ask", async () => {
    const execute = vi.fn(async () => 'fetched');
    const host: HostToolRegistry = { web_fetch: { descriptor: tool('web_fetch', execute) } };
    const options = agentPolicyOptions(effective({}), { agent: { tools: ['web_fetch'], approvals: ['web_fetch'], permissions: [{ tool: 'web_fetch', action: 'allow' }] } }, host);
    const result = await FlowExecutor.execute(
      { code: 'f', name: 'f', flow: { type: 'toolCall', tool: 'web_fetch', arguments: {} } },
      { agent: { id: 'a', name: 'a', prompt: 'p', settings: { model: 'mock' } }, provider: new MockLLMProvider({ name: 'mock', responses: [] }), variables: {}, toolRegistry: options.toolRegistry, permissions: options.permissions }
    );
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a policy deny refuses a required-approval tool without asking', async () => {
    const host: HostToolRegistry = { publish: { descriptor: tool('publish') } };
    const policy = effective({ approvals: { require: ['publish'] }, permissions: [{ id: 'no', tool: 'publish', action: 'deny' }] });
    const options = agentPolicyOptions(policy, { agent: agent({ tools: ['publish'] }) }, host);
    const approve = vi.fn(() => true);
    const result = await FlowExecutor.execute(
      { code: 'f', name: 'f', flow: { type: 'toolCall', tool: 'publish', arguments: {} } },
      { agent: { id: 'a', name: 'a', prompt: 'p', settings: { model: 'mock' } }, provider: new MockLLMProvider({ name: 'mock', responses: [] }), variables: {}, toolRegistry: options.toolRegistry, permissions: options.permissions, approve }
    );
    expect(result.success).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  it('builds createAgent tools only from the effective toolset and leaves the host descriptors untouched', () => {
    const host = registry(['publish', 'shell']);
    const options = agentPolicyOptions(effective({ tools: { allow: ['publish'] }, approvals: { require: ['publish'] } }), { agent: agent({ tools: ['publish', 'shell'] }) }, host);
    expect(Object.keys(options.tools)).toEqual(['publish']);
    expect(options.toolRegistry.list()).toEqual(['publish']);
    expect(typeof options.tools.publish.needsApproval).toBe('function');
    expect(host.publish.descriptor.needsApproval).toBeUndefined();
  });

  it('takes network and sandbox from the policy, which an agent can only tighten', () => {
    const policy = effective({ network: { allowHosts: ['api.example.com', 'cdn.example.com'] }, sandbox: { required: true } }, { network: { allowHosts: ['*.example.com'] } });
    const loose = agentPolicyOptions(policy, { agent: { tools: [], network: { allowHosts: ['*.example.com', 'evil.test'] }, sandbox: { required: false } } }, {});
    expect(loose.network.allowHosts.sort()).toEqual(['api.example.com', 'cdn.example.com']);
    expect(loose.sandbox.required).toBe(true);
    const tight = agentPolicyOptions(effective({}), { agent: { tools: [], network: { allowHosts: ['api.example.com'] }, sandbox: { required: true } } }, {});
    expect(tight.network.allowHosts).toEqual([]);
    expect(tight.sandbox.required).toBe(true);
  });

  it('reports an agent tool the host registry lacks', () => {
    const options = agentPolicyOptions(effective({}), { agent: agent({ tools: ['web'] }) }, registry(['web_fetch']));
    expect(options.warnings).toEqual([expect.stringContaining("'web'")]);
  });

  it('warns about an agent tool the allowlist or tools.only leaves out, naming the rule', () => {
    const options = agentPolicyOptions(effective({ tools: { allow: ['search_facts', 'render_video'] } }), { attachment: { tools: { only: ['search_facts'] } }, agent: agent({ tools: ['search_facts', 'render_video', 'shell'] }) }, registry(['search_facts', 'render_video', 'shell']));
    expect(options.warnings).toEqual([
      "the agent's tool 'render_video' is not in the attachment's tools.only, so the tool is left out",
      "the agent's tool 'shell' is not in the policy's tools.allow (the host ceiling narrowed by shared/policies/policy.json), so the tool is left out (R13)",
    ]);
  });
});

describe('pagePolicy', () => {
  const attachment = (alias: string, tools: string[], only?: string[]) => ({ alias, agentOwned: agent({ name: alias, tools }), pageOwned: { as: alias, ref: `workspace:${alias}`, ...(only && { tools: { only } }) } });

  it('a missing capability fails page start, not mid-run', () => {
    const execute = vi.fn();
    const host: HostToolRegistry = {
      render_video: { descriptor: tool('render_video', execute), capabilities: ['video.render'] },
      gen_image: { descriptor: tool('gen_image', execute), capabilities: ['image.generate'] },
    };
    const start = (policy: EffectivePolicy, only?: string[]) => pagePolicy(policy, { capabilities: ['image.generate', 'video.render'], attachments: [attachment('maker', ['render_video', 'gen_image'], only)] }, host);

    expect(Object.keys(start(effective({})).attachments)).toEqual(['maker']);
    expect(() => start(effective({ tools: { allow: ['render_video'] } }))).toThrow(expect.objectContaining({ code: 'LOUSHO_WORKSPACE_CAPABILITY_MISSING', message: expect.stringContaining("capability-missing: the page requires 'image.generate'") }));
    expect(() => start(effective({}), ['render_video'])).toThrow(/image\.generate/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a tool the policy denies outright provides no capability', () => {
    const host: HostToolRegistry = { gen_image: { descriptor: tool('gen_image'), capabilities: ['image.generate'] } };
    const page = { capabilities: ['image.generate'], attachments: [attachment('maker', ['gen_image'])] };
    expect(() => pagePolicy(effective({}, { permissions: [{ id: 'no', tool: 'gen_*', action: 'deny' }] }), page, host)).toThrow(/capability-missing/);
    expect(() => pagePolicy(effective({ permissions: [{ id: 'ask', tool: 'gen_image', action: 'ask' }] }), page, host)).not.toThrow();
  });

  it('counts a tool by the first matching rule of each list, as the runtime decides it', async () => {
    const host: HostToolRegistry = { gen_image: { descriptor: tool('gen_image'), capabilities: ['image.generate'] } };
    const page = (permissions?: AgentOwned['permissions']) => ({ capabilities: ['image.generate'], attachments: [{ ...attachment('maker', ['gen_image']), agentOwned: agent({ tools: ['gen_image'], permissions }) }] });
    const policy = effective({}, { permissions: [{ id: 'img', tool: 'gen_image', action: 'allow' }, { id: 'rest', tool: '*', action: 'deny' }] });
    expect(() => pagePolicy(policy, page([{ tool: 'gen_image', action: 'allow' }]), host)).not.toThrow();
    const { rules, warnings } = effectivePermissions(policy, [{ tool: 'gen_image', action: 'allow' }]);
    expect(await decide(rules, 'gen_image')).toBe('allow');
    expect(warnings).toEqual([]);
    expect(() => pagePolicy(effective({}), page([{ tool: 'gen_image', action: 'deny' }]), host)).toThrow(/capability-missing/);
  });

  it('a capability never grants a tool', () => {
    const host: HostToolRegistry = { gen_image: { descriptor: tool('gen_image'), capabilities: ['image.generate'] } };
    expect(() => pagePolicy(effective({}), { capabilities: ['image.generate'], attachments: [attachment('maker', [])] }, host)).toThrow(/capability-missing/);
  });

  it('gives each attachment its own options and collects warnings', () => {
    const policy = effective({ permissions: [{ id: 'no', tool: 'render_video', action: 'deny' }] });
    const owned = { ...attachment('maker', ['render_video', 'web']), agentOwned: agent({ tools: ['render_video', 'web'], permissions: [{ tool: 'render_video', action: 'allow' }] }) };
    const page = pagePolicy(policy, { attachments: [owned, attachment('writer', ['search_facts'])] }, registry(['render_video', 'search_facts']));
    expect(Object.keys(page.attachments.maker.tools)).toEqual(['render_video']);
    expect(Object.keys(page.attachments.writer.tools)).toEqual(['search_facts']);
    expect(page.warnings).toHaveLength(2);
  });
});

describe('runtime toolsets', () => {
  it('no code path under src/workspaces/runtime builds a toolset without effectiveToolset', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const builds = /\bcreateAgent\s*\(|new ToolRegistry\b|\.register(?:Many)?\s*\(|\btoolRegistry\s*[:=]|\bloadAgentDir\s*\(|\bcollectTools\s*\(/;
    const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.test-d.ts'));
    const building = sources.filter((file) => builds.test(readFileSync(`${dir}/${file}`, 'utf8'))).sort();
    expect(building).toEqual(['attachmentAgent.ts', 'mainAgent.ts', 'policy.ts']);
    const policy = readFileSync(`${dir}/policy.ts`, 'utf8');
    const builder = policy.slice(policy.indexOf('export function agentPolicyOptions'));
    expect(builder.slice(0, builder.indexOf('\n}\n'))).toMatch(/effectiveToolset\(/);
  });

  it('the page runtime builds agents only from the policy options, with every tool bound by the host', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const source = readFileSync(`${dir}/attachmentAgent.ts`, 'utf8');
    expect(source.match(/\bcreateAgent\s*\(/g)).toHaveLength(1);
    expect(source).toMatch(/tools: boundTools\(/);
    expect(source).toMatch(/permissions: policy\.permissions/);
    expect(source).toMatch(/Object\.entries\(policy\.tools\)/);
    expect(source).toMatch(/host\.bindTool\(/);
  });

  it('the main agent gets only its host-bound policy tools and the router tools', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const source = readFileSync(`${dir}/mainAgent.ts`, 'utf8');
    expect(source.match(/\bcreateAgent\s*\(/g)).toHaveLength(1);
    expect(source).toMatch(/agentPolicyOptions\(effectivePolicy\(/);
    expect(source).toMatch(/Object\.entries\(policy\.tools\)/);
    expect(source).toMatch(/host\.bindTool\(/);
    expect(source).toMatch(/tools: \{ \.\.\.own, \.\.\.options\.routerTools \}/);
    expect(source).toMatch(/permissions: policy\.permissions/);
  });
});
