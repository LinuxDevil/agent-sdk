/**
 * The Worker node shim must export every name the shimmed SDK modules import
 * from Node builtins: a missing one fails every Worker build (`No matching
 * export`), and an unshimmed importer leaks `node:fs` into the bundle - as
 * `skills/withSkills` and `AgentSession`'s `createHash` did.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_SHIMMED_IMPORTERS } from '../bundle';
import * as shim from './node.worker';

const SRC = join(__dirname, '..', '..');

/** The bindings `source` imports from `node:*` modules: named imports, `promises as fs`, and `default` for `import x from`. */
function nodeImports(source: string): string[] {
  const names: string[] = [];
  for (const [, clause] of source.matchAll(/^import\s+(?!type\b)(.+?)\s+from\s+'node:[a-z_/]+';/gm)) {
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) names.push(...named[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    const head = clause.replace(/\{[^}]*\}/, '').replace(/,\s*$/, '').trim();
    if (head && !head.startsWith('* as')) names.push('default');
  }
  return names;
}

describe('the Worker node shim', () => {
  it.each(NODE_SHIMMED_IMPORTERS)('exports every Node builtin binding %s imports', (module) => {
    const missing = nodeImports(readFileSync(join(SRC, `${module}.ts`), 'utf8')).filter((name) => !(name in shim));
    expect(missing).toEqual([]);
  });

  it('shims the modules createAgent() reaches that read files (skills, the file stores retry)', () => {
    expect(NODE_SHIMMED_IMPORTERS).toEqual(expect.arrayContaining(['skills/withSkills', 'storage/fsRetry']));
    expect(nodeImports(readFileSync(join(SRC, 'storage/fsRetry.ts'), 'utf8'))).toEqual(['readFile', 'rename']);
    expect(nodeImports("import path from 'node:path';\nimport { promises as fs, statSync } from 'node:fs';")).toEqual(['default', 'promises', 'statSync']);
  });
});
