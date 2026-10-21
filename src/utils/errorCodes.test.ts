/**
 * The error-code registry, the codes used in src/ and docs/errors.md
 * cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ERROR_CODES, ERROR_DOCS_URL, errorDocsUrl, errorHelp } from './errorCodes';

const SRC = resolve(__dirname, '..');
const DOCS = readFileSync(resolve(SRC, '..', 'docs', 'errors.md'), 'utf8');
const CODES = Object.keys(ERROR_CODES);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test(-d)?\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('error codes', () => {
  it('every code is LOUSHO_<AREA>_<NAME> with a one-sentence hint', () => {
    for (const code of CODES) {
      expect(code).toMatch(/^LOUSHO_[A-Z]+_[A-Z0-9_]+$/);
      const hint = ERROR_CODES[code as keyof typeof ERROR_CODES];
      expect(hint, code).toMatch(/^[^\n]+\.$/);
    }
  });

  it('every code used in src/ is in the registry', () => {
    // Codes share the LOUSHO_ prefix with env vars (LOUSHO_MODEL, ...), so match the registry's areas only.
    const areas = [...new Set(CODES.map((code) => code.split('_')[1]))];
    const pattern = new RegExp(`\\bLOUSHO_(?:${areas.join('|')})_[A-Z0-9_]+\\b`, 'g');
    const used = new Set(sourceFiles(SRC).flatMap((file) => readFileSync(file, 'utf8').match(pattern) ?? []));
    expect(used.size).toBeGreaterThan(10);
    // Environment variables that share a registry area's prefix (LOUSHO_TOKEN_KEY) are not codes.
    const envVars = ['LOUSHO_TOKEN_KEY'];
    expect([...used].filter((code) => !CODES.includes(code) && !envVars.includes(code))).toEqual([]);
  });

  it('every registry code has a section in docs/errors.md, and every section a registry code', () => {
    const headings = [...DOCS.matchAll(/^### (LOUSHO_[A-Z0-9_]+)\s*$/gm)].map((m) => m[1]);
    expect([...headings].sort()).toEqual([...CODES].sort());
  });

  it('links to the lousho.com page, whose anchors keep the underscores of the heading', () => {
    expect(ERROR_DOCS_URL).toBe('https://lousho.com/errors');
    expect(errorDocsUrl('LOUSHO_REGISTRY_UNREACHABLE')).toBe('https://lousho.com/errors#lousho_registry_unreachable');
    // Mintlify slugifies `## LOUSHO_X` to `lousho_x`, which is the code in lowercase.
    for (const code of CODES) expect(DOCS).toContain(`## ${code}`);
  });

  it('docs links point at the code section anchors', () => {
    expect(errorDocsUrl('LOUSHO_PEER_MISSING')).toBe(`${ERROR_DOCS_URL}#lousho_peer_missing`);
    expect(errorHelp('LOUSHO_PEER_MISSING')).toEqual({
      hint: ERROR_CODES.LOUSHO_PEER_MISSING,
      docs: `${ERROR_DOCS_URL}#lousho_peer_missing`,
    });
    expect(errorHelp('NOT_A_CODE')).toBeUndefined();
    expect(errorHelp('toString')).toBeUndefined();
  });
});
