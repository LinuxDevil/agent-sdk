/** N10a: an agent directory's auth.ts. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentDir } from './loadAgentDir';
import { mockModel } from '../testing';
import { routeAuth } from '../auth';

const fixture = (name: string) => path.join(__dirname, '__fixtures__', name);

function tempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-auth-dir-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

describe('agent directory auth.ts (N10a)', () => {
  it('resolveAgentDir() returns the default-exported list and marks the manifest', async () => {
    const { auth, manifest } = await resolveAgentDir(fixture('auth'), { provider: mockModel(['x']) });
    expect(manifest.auth).toBe(true);
    expect(manifest.files.some((file) => file.endsWith('auth.ts'))).toBe(true);
    expect(Array.isArray(auth) && auth.length).toBe(2);
    const outcome = await routeAuth(new Request('https://a.test/', { headers: { authorization: 'Bearer dir-token' } }), auth!);
    expect(outcome).toMatchObject({ ok: true, principal: { authenticator: 'api-token' } });
  });

  it('is absent without an auth file', async () => {
    const { auth, manifest } = await resolveAgentDir(fixture('channels'), { provider: mockModel(['x']) });
    expect(auth).toBeUndefined();
    expect(manifest.auth).toBe(false);
  });

  it('takes a single function, and rejects other exports and two auth files', async () => {
    const single = tempDir({ 'instructions.md': 'x', 'auth.mjs': 'export default () => null;' });
    expect(typeof (await resolveAgentDir(single, { provider: mockModel(['x']) })).auth).toBe('function');
    const bad = tempDir({ 'instructions.md': 'x', 'auth.mjs': "export default 'token';" });
    await expect(resolveAgentDir(bad, { provider: mockModel(['x']) })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DIR_INVALID' });
    const two = tempDir({ 'instructions.md': 'x', 'auth.mjs': 'export default [];', 'auth.js': 'export default [];' });
    await expect(resolveAgentDir(two, { provider: mockModel(['x']) })).rejects.toThrow(/Keep one auth file/);
  });
});
