import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(permissions: unknown) {
  return { ...base, permissions };
}

function rule(fields: Record<string, unknown>) {
  return spec([{ id: 'p1', tool: 'shell', action: 'deny', ...fields }]);
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('spec v2 permissions', () => {
  it('accepts rules with a tool name, a glob list, when matchers, reason and ttlMs', () => {
    const permissions = [
      { id: 'p1', tool: 'shell', when: { command: '\\brm\\b' }, action: 'deny', reason: 'No deletes' },
      { id: 'p2', tool: ['github_*', 'jira_create_issue'], action: 'ask', ttlMs: 60000 },
      { id: 'p3', tool: '*', action: 'allow' },
    ];
    expect(parseAgentSpecV2(spec(permissions)).permissions).toEqual(permissions);
  });

  it('requires when to name at least one argument', () => {
    const error = thrown(rule({ when: {} }));
    expect(error.errors).toHaveProperty('permissions.0.when');
    expect(error.message).toContain('must name at least one argument');
  });

  it('accepts a when operator object setting several operators', () => {
    const permissions = [{ id: 'p1', tool: 'deploy', action: 'ask', when: { replicas: { gte: 1, lte: 10 } } }];
    expect(parseAgentSpecV2(spec(permissions)).permissions).toEqual(permissions);
  });

  it('rejects an unknown key in a when operator object', () => {
    const error = thrown(rule({ when: { x: { foo: 1 } } }));
    expect(error.message).toContain('nrecognized key');
  });

  it('rejects an empty when operator object', () => {
    const error = thrown(rule({ when: { x: {} } }));
    expect(error.errors).toHaveProperty('permissions.0.when.x');
    expect(error.message).toContain('must set at least one of');
  });

  it('rejects a when regex string that does not compile', () => {
    const error = thrown(rule({ when: { cmd: '(' } }));
    expect(error.errors).toHaveProperty('permissions.0.when.cmd');
    expect(error.message).toContain('is not a valid regular expression');
  });

  it('rejects a when matches regex that does not compile', () => {
    const error = thrown(rule({ when: { cmd: { matches: '[' } } }));
    expect(error.message).toContain('is not a valid regular expression');
  });

  it("rejects ttlMs on a rule whose action is not 'ask'", () => {
    const error = thrown(rule({ action: 'allow', ttlMs: 1000 }));
    expect(error.errors).toHaveProperty('permissions.0.ttlMs');
    expect(error.message).toContain("only 'ask' rules wait for a decision; remove ttlMs");
  });

  it('rejects glob syntax other than * and ? in tool', () => {
    const error = thrown(rule({ tool: 'read_[a-z]' }));
    expect(error.errors).toHaveProperty('permissions.0.tool');
    expect(error.message).toContain("must be a tool name, '*' or a glob using * and ?");
  });

  it('rejects an empty tool list', () => {
    const error = thrown(rule({ tool: [] }));
    expect(error.errors).toHaveProperty('permissions.0.tool');
  });

  it('rejects duplicate ids', () => {
    const error = thrown(
      spec([
        { id: 'p1', tool: 'shell', action: 'deny' },
        { id: 'p1', tool: 'read_file', action: 'allow' },
      ])
    );
    expect(error.message).toContain("duplicate id 'p1'");
    expect(error.errors).toHaveProperty('permissions.1.id');
  });

  it("rejects action 'auto' as not supported yet", () => {
    const error = thrown(rule({ action: 'auto' }));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.errors).toHaveProperty('permissions.0.action');
    expect(error.message).toContain("action 'auto'");
  });
});
