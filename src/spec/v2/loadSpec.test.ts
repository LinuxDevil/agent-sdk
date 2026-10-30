import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpecV2 } from './loadSpec';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-specv2-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('loadSpecV2', () => {
  it('loads a v1 YAML spec, upgraded and validated as v2', () => {
    const filePath = tmpFile(
      'agent.yaml',
      'name: bot\nprompt: Hi\nprovider: { type: mock, model: m }\npolicy: { limits: { maxSteps: 3 } }\n'
    );
    expect(loadSpecV2(filePath)).toEqual({
      version: 2,
      name: 'bot',
      model: 'mock/m',
      instructions: 'Hi',
      limits: { maxSteps: 3 },
    });
  });

  it('loads a v1 spec using only the landed sections (askQuestion, compaction, mcpServers)', () => {
    const filePath = tmpFile(
      'agent.yaml',
      'name: bot\nprompt: Hi\nprovider: { type: mock, model: m }\n' +
        'policy: { askQuestion: true, compaction: { thresholdPercent: 0.8 } }\n' +
        'mcpServers: { fs: { command: npx } }\n'
    );
    const spec = loadSpecV2(filePath);
    expect(spec.askQuestion).toBe(true);
    expect(spec.compaction).toEqual({ thresholdPercent: 0.8 });
    expect(spec.mcpServers).toEqual({ fs: { command: 'npx' } });
  });

  it('loads a v2 JSON spec, validated', () => {
    const spec = { version: 2, name: 'bot', model: 'mock/m', instructions: 'Hi' };
    const filePath = tmpFile('agent.json', JSON.stringify(spec));
    expect(loadSpecV2(filePath)).toEqual(spec);
  });

  it('throws LOUSHO_SPEC_NOT_FOUND for a path that does not exist', () => {
    const missing = path.join(os.tmpdir(), `lousho-specv2-missing-${process.pid}.yaml`);
    expect(() => loadSpecV2(missing)).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_NOT_FOUND' }));
    expect(() => loadSpecV2(missing)).not.toThrow(/ENOENT/);
  });

  it('throws LOUSHO_SPEC_UNSUPPORTED_FORMAT for an unsupported extension', () => {
    const filePath = tmpFile('agent.toml', 'name = "bot"');
    expect(() => loadSpecV2(filePath)).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_UNSUPPORTED_FORMAT' }));
  });

  it('throws LOUSHO_SPEC_INVALID for broken YAML', () => {
    const filePath = tmpFile('broken.yaml', 'name: x\ntools: [a\n  - b\n');
    expect(() => loadSpecV2(filePath)).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_INVALID' }));
  });

  it('throws LOUSHO_SPEC_INVALID naming the file for an invalid v2 spec', () => {
    const filePath = tmpFile('bad.yaml', 'version: 2\nname: bot\nmodel: gpt-4o\ninstructions: Hi\n');
    expect(() => loadSpecV2(filePath)).toThrow(
      expect.objectContaining({ code: 'LOUSHO_SPEC_INVALID', message: expect.stringContaining(filePath) })
    );
  });

  it('throws LOUSHO_SPEC_UNSUPPORTED for a v1 spec with tools until the tools section lands', () => {
    const filePath = tmpFile('tools.yaml', 'name: bot\nprompt: Hi\nprovider: { type: mock, model: m }\ntools: [http]\n');
    expect(() => loadSpecV2(filePath)).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_UNSUPPORTED' }));
  });
});
