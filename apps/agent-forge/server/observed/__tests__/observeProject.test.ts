import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { observeProjectOf } from '../observeProject';

/**
 * W07a: Studio's copy of the SDK's `resolveProject` - env wins, then the
 * workspace root's package.json `name`, else 'default'.
 */

describe('observeProjectOf', () => {
  let dir: string;
  const ENV = 'LOUSHO_OBSERVE_PROJECT';
  let saved: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w07a-proj-'));
    saved = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the env var wins over package.json', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-name' }));
    process.env[ENV] = 'env-project';
    expect(observeProjectOf(dir)).toBe('env-project');
  });

  it('reads the package.json name', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-agent-pack' }));
    expect(observeProjectOf(dir)).toBe('my-agent-pack');
  });

  it("answers 'default' for a missing or invalid package.json", () => {
    expect(observeProjectOf(dir)).toBe('default');
    fs.writeFileSync(path.join(dir, 'package.json'), 'not json {');
    expect(observeProjectOf(dir)).toBe('default');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 42 }));
    expect(observeProjectOf(dir)).toBe('default');
  });
});
