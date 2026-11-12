import { describe, expect, it } from 'vitest';
import { ImportError, parseImportText } from '../import';

const V1_YAML = ['name: Support triage', 'prompt: Help the users.', 'provider:', '  type: anthropic', '  model: claude-sonnet-5-5', ''].join('\n');

const V2_JSON = JSON.stringify({
  version: 2,
  name: 'Ops Bot',
  model: 'mock/mock-1',
  instructions: 'Do the ops.',
});

const BUNDLE = JSON.stringify({
  kind: 'lousho.agent-bundle',
  version: 1,
  spec: { version: 2, name: 'Bundle Bot', model: 'mock/mock-1', instructions: 'From a bundle.' },
  labels: [' Prod ', 'OPS', 'prod'],
  prompts: [
    { name: 'support', version: 3, content: 'Be nice.' },
    { name: 'broken' },
  ],
  exportedAt: '2026-01-01T00:00:00.000Z',
});

describe('parseImportText', () => {
  it('parses a v1 YAML spec, upgrades it to v2 and warns', () => {
    const parsed = parseImportText(V1_YAML);
    expect(parsed.format).toBe('yaml');
    expect(parsed.spec).toMatchObject({ version: 2, name: 'Support triage' });
    expect(parsed.warnings).toEqual(['Upgraded from spec v1.']);
    expect(parsed.labels).toEqual([]);
    expect(parsed.prompts).toEqual([]);
  });

  it('parses a v2 JSON spec without the upgrade warning', () => {
    const parsed = parseImportText(V2_JSON);
    expect(parsed.format).toBe('json');
    expect(parsed.spec).toMatchObject({ version: 2, name: 'Ops Bot' });
    expect(parsed.warnings).toEqual([]);
  });

  it('parses a bundle: labels normalised, prompts kept, malformed prompt dropped', () => {
    const parsed = parseImportText(BUNDLE);
    expect(parsed.format).toBe('bundle');
    expect(parsed.spec).toMatchObject({ version: 2, name: 'Bundle Bot' });
    expect(parsed.labels).toEqual(['prod', 'ops']);
    expect(parsed.prompts).toEqual([{ name: 'support', version: 3, content: 'Be nice.' }]);
    expect(parsed.warnings).toEqual([]);
  });

  it('refuses a bundle made by a newer Studio', () => {
    const bundle = JSON.stringify({ ...JSON.parse(BUNDLE), version: 2 });
    try {
      parseImportText(bundle);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      const failure = error as ImportError;
      expect(failure.status).toBe(400);
      expect(failure.code).toBe('LOUSHO_IMPORT_BUNDLE_VERSION');
      expect(failure.message).toBe('This bundle was made by a newer Studio (version 2).');
    }
  });

  it('turns invalid bundle labels into LOUSHO_IMPORT_INVALID', () => {
    const bundle = JSON.stringify({ ...JSON.parse(BUNDLE), labels: ['x'.repeat(33)] });
    try {
      parseImportText(bundle);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).status).toBe(400);
      expect((error as ImportError).code).toBe('LOUSHO_IMPORT_INVALID');
      expect((error as ImportError).message).toContain('32 characters');
    }
  });

  it('rejects empty text', () => {
    try {
      parseImportText('   \n  ');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('LOUSHO_IMPORT_EMPTY');
      expect((error as ImportError).status).toBe(400);
    }
  });

  it('rejects text over 1 MB before parsing', () => {
    try {
      parseImportText(`name: x\n# ${'a'.repeat(1024 * 1024)}`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('LOUSHO_IMPORT_TOO_LARGE');
      expect((error as ImportError).status).toBe(400);
    }
  });

  it('rejects invalid JSON with the parser message', () => {
    try {
      parseImportText('{not json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('LOUSHO_IMPORT_INVALID');
      expect((error as ImportError).message).toMatch(/^Not valid JSON: /);
    }
  });

  it('rejects invalid YAML with the parser message', () => {
    try {
      parseImportText('name: "unclosed');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('LOUSHO_IMPORT_INVALID');
      expect((error as ImportError).message).toMatch(/^Not valid YAML: /);
    }
  });

  it('reports the first schema issue path in error and all issues in details', () => {
    try {
      parseImportText(JSON.stringify({ version: 2, name: 'x' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      const failure = error as ImportError;
      expect(failure.status).toBe(400);
      expect(failure.code).toBe('LOUSHO_IMPORT_INVALID');
      expect(failure.message).toMatch(/^[\w.]+: /);
      const details = failure.details as { issues: { path: string; message: string }[] };
      expect(details.issues.length).toBeGreaterThan(0);
      expect(failure.message).toBe(`${details.issues[0].path}: ${details.issues[0].message}`);
    }
  });
});
