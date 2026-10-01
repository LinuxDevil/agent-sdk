/**
 * LOU-D2: the error-code registry, the codes used in src/ and docs/errors.md
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

describe('error codes (LOU-D2)', () => {
  it('every code is LOUSHY_<AREA>_<NAME> with a one-sentence hint', () => {
    for (const code of CODES) {
      expect(code).toMatch(/^LOUSHY_[A-Z]+_[A-Z0-9_]+$/);
      const hint = ERROR_CODES[code as keyof typeof ERROR_CODES];
      expect(hint, code).toMatch(/^[^\n]+\.$/);
    }
  });

  it('every code used in src/ is in the registry', () => {
    // Codes share the LOUSHY_ prefix with env vars (LOUSHY_MODEL, ...), so match the registry's areas only.
    const areas = [...new Set(CODES.map((code) => code.split('_')[1]))];
    const pattern = new RegExp(`\\bLOUSHY_(?:${areas.join('|')})_[A-Z0-9_]+\\b`, 'g');
    const used = new Set(sourceFiles(SRC).flatMap((file) => readFileSync(file, 'utf8').match(pattern) ?? []));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((code) => !CODES.includes(code))).toEqual([]);
  });

  it('every registry code has a section in docs/errors.md, and every section a registry code', () => {
    const headings = [...DOCS.matchAll(/^### (LOUSHY_[A-Z0-9_]+)\s*$/gm)].map((m) => m[1]);
    expect([...headings].sort()).toEqual([...CODES].sort());
  });

  it('docs links point at the code section anchors', () => {
    expect(errorDocsUrl('LOUSHY_PEER_MISSING')).toBe(`${ERROR_DOCS_URL}#loushy_peer_missing`);
    expect(errorHelp('LOUSHY_PEER_MISSING')).toEqual({
      hint: ERROR_CODES.LOUSHY_PEER_MISSING,
      docs: `${ERROR_DOCS_URL}#loushy_peer_missing`,
    });
    expect(errorHelp('NOT_A_CODE')).toBeUndefined();
    expect(errorHelp('toString')).toBeUndefined();
  });
});
