import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { downloadSpec, importSpecFile, parseSpecText, serializeSpec } from '../importExport';

const spec: AgentSpec = {
  name: 'research-assistant',
  prompt: 'Research a topic and summarize findings.',
  provider: { type: 'anthropic', model: 'claude-3.7-sonnet' },
  tools: ['http', 'current-date'],
};

describe('serializeSpec / parseSpecText', () => {
  it('round-trips through YAML', () => {
    const text = serializeSpec(spec, 'yaml');
    expect(parseSpecText(text, 'yaml')).toEqual(spec);
  });

  it('round-trips through JSON', () => {
    const text = serializeSpec(spec, 'json');
    expect(parseSpecText(text, 'json')).toEqual(spec);
  });

  it('rejects invalid spec text with a field-naming error', () => {
    expect(() => parseSpecText('name: only-a-name', 'yaml')).toThrow(/'prompt'/);
  });
});

describe('importSpecFile', () => {
  it('parses an uploaded .yaml File', async () => {
    const file = new File([serializeSpec(spec, 'yaml')], 'agent.yaml', { type: 'text/yaml' });
    expect(await importSpecFile(file)).toEqual(spec);
  });

  it('parses an uploaded .json File', async () => {
    const file = new File([serializeSpec(spec, 'json')], 'agent.json', { type: 'application/json' });
    expect(await importSpecFile(file)).toEqual(spec);
  });
});

describe('downloadSpec', () => {
  it('creates and revokes a Blob object URL to drive the download', () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    // jsdom has no real download/navigation support, so an <a> click with
    // an href it doesn't recognize logs an unimplemented-navigation error;
    // stub HTMLAnchorElement.click to isolate this test from that jsdom
    // limitation and just assert the Blob URL lifecycle we control.
    const originalClick = HTMLAnchorElement.prototype.click;
    let created = 0;
    let revoked = 0;
    URL.createObjectURL = () => {
      created++;
      return 'blob:mock';
    };
    URL.revokeObjectURL = () => {
      revoked++;
    };
    HTMLAnchorElement.prototype.click = () => {};

    try {
      downloadSpec(spec, 'research-assistant.yaml');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }

    expect(created).toBe(1);
    expect(revoked).toBe(1);
  });
});
