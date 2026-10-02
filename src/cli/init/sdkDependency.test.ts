import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSdkDependency } from './sdkDependency';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-sdkdep-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveSdkDependency', () => {
  it('is a caret range of the SDK version by default and writes nothing', () => {
    const project = tempDir();
    expect(resolveSdkDependency('1.0.0-alpha.8', project)).toBe('^1.0.0-alpha.8');
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it('copies a given tarball into the project and points at it with file:', () => {
    const tarball = path.join(tempDir(), 'sdk-1.2.3.tgz');
    fs.writeFileSync(tarball, 'not really a tarball');
    const project = tempDir();

    expect(resolveSdkDependency('1.0.0', project, tarball)).toBe('file:./sdk-1.2.3.tgz');
    expect(fs.readFileSync(path.join(project, 'sdk-1.2.3.tgz'), 'utf8')).toBe('not really a tarball');
  });

  it('explains a missing path and a non-tarball file', () => {
    const project = tempDir();
    expect(() => resolveSdkDependency('1.0.0', project, path.join(project, 'nope'))).toThrow(/does not exist/);

    const notTarball = path.join(tempDir(), 'sdk.txt');
    fs.writeFileSync(notTarball, 'x');
    expect(() => resolveSdkDependency('1.0.0', project, notTarball)).toThrow(/not a \.tgz/);
  });
});
