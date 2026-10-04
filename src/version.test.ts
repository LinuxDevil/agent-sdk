/**
 * A7 (#245): the `VERSION` constant the package exports must equal the
 * `version` field of package.json - the release flow bumps one, and before
 * this test nothing checked they stayed in sync (alpha.9 shipped with
 * `VERSION` still reading `1.0.0-alpha.8`).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSION } from './index';

describe('VERSION', () => {
  it('equals the package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
