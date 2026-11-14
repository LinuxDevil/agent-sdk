import { describe, it, expect } from 'vitest';
import { formatSpecValue } from '../formatSpecValue';

describe('formatSpecValue tools', () => {
  it('names each ToolRef form', () => {
    expect(formatSpecValue('tools', [{ builtin: 'web_fetch' }])).toBe('web_fetch');
    expect(formatSpecValue('tools', [{ registry: 'jira-tools' }])).toBe('jira-tools (registry)');
    expect(formatSpecValue('tools', [{ file: 'tools/lookup.py' }])).toBe('lookup.py');
    expect(formatSpecValue('tools', [{ integration: 'github' }])).toBe('github integration');
    expect(formatSpecValue('tools', [{ openapi: { url: 'https://api.example.com/spec.json' } }])).toBe(
      'api.example.com'
    );
    expect(formatSpecValue('tools', [{ hosted: 'web_search' }])).toBe('web_search (hosted)');
    expect(formatSpecValue('tools', [{ hub: true }])).toBe('Context hub');
  });

  it('joins a list and appends " · approval" for approval: always', () => {
    expect(
      formatSpecValue('tools', [
        { builtin: 'read_file', approval: 'always' },
        { builtin: 'list_files' },
      ])
    ).toBe('read_file · approval, list_files');
  });

  it('falls back to JSON for an openapi ref whose url will not parse', () => {
    expect(formatSpecValue('tools', [{ openapi: { url: 'not a url' } }])).toBe('not a url');
  });
});

describe('formatSpecValue triggers', () => {
  it('names each trigger form', () => {
    expect(formatSpecValue('triggers', [{ id: 't1', type: 'chat' }])).toBe('Chat');
    expect(formatSpecValue('triggers', [{ id: 't2', type: 'cron', cron: '0 9 * * *', timezone: 'UTC', prompt: 'x' }])).toBe(
      'Cron 0 9 * * * UTC'
    );
    expect(formatSpecValue('triggers', [{ id: 't3', type: 'webhook', path: '/hooks/in', promptTemplate: 'x' }])).toBe(
      'Webhook /hooks/in'
    );
    expect(formatSpecValue('triggers', [{ id: 't4', type: 'channel', channel: 'slack', secrets: {} }])).toBe(
      'Slack channel'
    );
    expect(
      formatSpecValue('triggers', [{ id: 't5', type: 'agent', after: 'ingest', on: 'done', promptTemplate: 'x' }])
    ).toBe('After ingest (done)');
  });
});

describe('formatSpecValue collections', () => {
  it('mcpServers joins the keys', () => {
    expect(formatSpecValue('mcpServers', { github: {}, jira: {} })).toBe('github, jira');
  });

  it('subagents joins the keys', () => {
    expect(formatSpecValue('subagents', { researcher: { ref: 'a.yaml' }, writer: { ref: 'b.yaml' } })).toBe(
      'researcher, writer'
    );
  });

  it('handoffs lists the target agents', () => {
    expect(formatSpecValue('handoffs', [{ agent: 'human-triage' }, { agent: 'escalations' }])).toBe(
      'human-triage, escalations'
    );
  });

  it('guardrails shows "<name> (<on>)" with the default sides', () => {
    expect(formatSpecValue('guardrails', [{ id: 'g1', name: 'pii' }])).toBe('pii (input, output)');
    expect(formatSpecValue('guardrails', [{ id: 'g2', name: 'regex', on: 'output' }])).toBe('regex (output)');
    expect(formatSpecValue('guardrails', [{ id: 'g3', name: 'pii', on: ['input', 'tools'] }])).toBe('pii (input, tools)');
  });

  it('permissions shows "<action> <tool>" for a string or a list', () => {
    expect(formatSpecValue('permissions', [{ id: 'p1', tool: 'write_file', action: 'ask' }])).toBe('ask write_file');
    expect(formatSpecValue('permissions', [{ id: 'p2', tool: ['read_file', 'list_files'], action: 'allow' }])).toBe(
      'allow read_file, list_files'
    );
  });
});

describe('formatSpecValue fallback', () => {
  it('plain values render as-is', () => {
    expect(formatSpecValue('model', 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5-5');
    expect(formatSpecValue('fallbackModels', ['a/1', 'b/2'])).toBe('a/1, b/2');
    expect(formatSpecValue('name', 'Triage')).toBe('Triage');
  });

  it('other objects JSON.stringify clipped to 120 chars', () => {
    const long = { a: 'x'.repeat(200) };
    const out = formatSpecValue('modelSettings', long);
    expect(out.length).toBe(121); // 120 + ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(formatSpecValue('modelSettings', { maxTokens: 2000 })).toBe('{"maxTokens":2000}');
  });
});
