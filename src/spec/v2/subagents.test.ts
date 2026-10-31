import { describe, it, expect } from 'vitest';
import { issueMessage, issuePath } from '../../utils/zodCompat';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'lead', model: 'anthropic/claude-sonnet-5-5', instructions: 'Lead.' };

/** A minimal valid inline sub-agent spec (an AgentSpecV2 without version/triggers/flow/evals, with a description). */
const research = { name: 'research', description: 'Finds sources', model: 'openai/gpt-4o-mini', instructions: 'Research.' };

function parse(subagents: unknown) {
  return agentSpecV2Schema.safeParse({ ...base, subagents });
}

function issues(data: unknown) {
  const result = agentSpecV2Schema.safeParse(data);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issuePath(issue), message: issueMessage(issue) }));
}

describe('agentSpecV2Schema subagents', () => {
  it('accepts an inline sub-agent', () => {
    const result = parse({ research: { inline: research } });
    expect(result.success).toBe(true);
  });

  it('requires the inline agent a description, at its own path', () => {
    const { description, ...noDescription } = research;
    void description;
    const result = parse({ research: { inline: noDescription } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((entry) => issuePath(entry) === 'subagents.research.inline.description');
    expect(issue).toBeDefined();
    expect(issueMessage(issue ?? { message: '' })).toContain('is required for a sub-agent');
  });

  it('rejects top-level-only keys on an inline agent', () => {
    for (const key of ['triggers', 'flow', 'evals', 'version']) {
      const result = parse({ research: { inline: { ...research, [key]: key === 'version' ? 2 : [] } } });
      expect(result.success, `${key} must be rejected`).toBe(false);
      if (result.success) continue;
      const problem = result.error.issues.find((entry) => issuePath(entry) === 'subagents.research.inline');
      expect(problem, `${key} issue path`).toBeDefined();
      expect(issueMessage(problem ?? { message: '' })).toContain(key);
    }
  });

  it('rejects an unknown key on an inline agent', () => {
    const result = parse({ research: { inline: { ...research, bogus: true } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const problem = result.error.issues.find((entry) => issuePath(entry) === 'subagents.research.inline');
    expect(problem).toBeDefined();
    expect(issueMessage(problem ?? { message: '' })).toContain('bogus');
  });

  it('accepts a nested sub-agent inside an inline agent', () => {
    const result = parse({ research: { inline: { ...research, subagents: { deep: { inline: research } } } } });
    expect(result.success).toBe(true);
  });

  it('accepts a ref to a spec file inside the agent folder', () => {
    expect(parse({ billing: { ref: 'agents/billing.yaml' } }).success).toBe(true);
  });

  it('rejects a ref that escapes the agent folder', () => {
    const result = parse({ billing: { ref: '../x.yaml' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((entry) => issuePath(entry) === 'subagents.billing.ref')).toBe(true);
  });

  it('accepts a remote sub-agent with a secret-ref auth', () => {
    const result = parse({
      api: { remote: { url: 'https://agents.example.com/support', auth: { env: 'SUPPORT_TOKEN' }, description: 'Support' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a literal string as remote auth at subagents.<name>.remote.auth', () => {
    const result = parse({
      api: { remote: { url: 'https://agents.example.com/support', auth: 'tok', description: 'Support' } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((entry) => issuePath(entry) === 'subagents.api.remote.auth')).toBe(true);
  });

  it('requires exactly one of ref, inline, remote', () => {
    for (const subagents of [
      { x: { ref: 'a.yaml', inline: research } },
      { x: {} },
      { x: { ref: 'a.yaml', remote: { url: 'https://a.example.com', description: 'A' } } },
    ]) {
      const result = parse(subagents);
      expect(result.success).toBe(false);
      if (result.success) continue;
      const issue = result.error.issues.find((entry) => issuePath(entry) === 'subagents.x');
      expect(issue).toBeDefined();
      expect(issueMessage(issue ?? { message: '' })).toContain('exactly one of ref, inline, remote');
    }
  });

  it('rejects a sub-agent name the pattern refuses', () => {
    const result = parse({ 'bad name': { ref: 'a.yaml' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    // zod 4 nests the regex failure inside an 'invalid_key' issue; zod 3 reports it directly.
    expect(JSON.stringify(result.error.issues)).toContain('sub-agent names');
  });

  it('validates an inline agent tools list exactly as the root does', () => {
    const rootIssues = issues({ ...base, tools: [{ builtin: 'nope' }] });
    const inline = issues({ ...base, subagents: { research: { inline: { ...research, tools: [{ builtin: 'nope' }] } } } });
    expect(rootIssues.length).toBeGreaterThan(0);
    expect(inline.some((entry) => entry.path === 'subagents.research.inline.tools.0.builtin' && entry.message === rootIssues[0].message)).toBe(
      true
    );
  });
});
