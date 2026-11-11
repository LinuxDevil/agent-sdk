import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
import { ValidationError } from '../../execution/errors';
import type { ArtifactScope } from './artifacts';
import { fileArtifactStore } from './fileArtifactStore';

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ignoresCase(dir: string): Promise<boolean> {
  await writeFile(join(dir, 'Probe'), '');
  try {
    await lstat(join(dir, 'probe'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(join(dir, 'Probe'), { force: true });
  }
}

const page: ArtifactScope = { workspace: 'marketing', runId: 'run-a' };

const TRAVERSAL_URIS = [
  'artifact://marketing/run-a/..',
  'artifact://marketing/run-a/.hidden',
  'artifact://marketing/run-a/..%2F..%2Fsecrets',
  'artifact://marketing/..%2F..%2Fother/a.md',
  'artifact://marketing/run-a/%2Fetc%2Fpasswd',
  'artifact://marketing/run-a/..%5C..%5Cx',
  'artifact://marketing/run-a/a%5Cb',
  'artifact://marketing/run-a/a%00b',
  'artifact://marketing/%2E%2E/a.md',
  'artifact://marketing/run-a/a/b.md',
];

describe('fileArtifactStore', () => {
  it('writes to <root>/<workspace>/runs/<runId>/artifacts/<name>', async () => {
    const root = await tempDir('lousho-artifacts-');
    await fileArtifactStore(root).put(page, 'post.md', '# Hi', 'text/markdown');
    expect(await readFile(join(root, 'marketing', 'runs', 'run-a', 'artifacts', 'post.md'), 'utf8')).toBe('# Hi');
  });

  it.each(TRAVERSAL_URIS)('get refuses the traversal uri %s', async (uri) => {
    const root = await tempDir('lousho-artifacts-');
    await expect(fileArtifactStore(root).get(uri, page)).rejects.toBeInstanceOf(ValidationError);
  });

  it('put refuses traversal names and writes nothing outside the root', async () => {
    const parent = await tempDir('lousho-artifacts-');
    const root = join(parent, 'root');
    const store = fileArtifactStore(root);
    for (const name of ['..', '../escape.md', '..\\escape.md', '/etc/passwd', '.hidden']) {
      await expect(store.put(page, name, 'x', 'text/plain')).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(store.put({ workspace: 'marketing', runId: '../../escape' }, 'a.md', 'x', 'text/plain')).rejects.toBeInstanceOf(ValidationError);
    expect(await readdir(parent)).toEqual([]);
  });

  it.each([
    ['the workspace folder', ['marketing']],
    ['the runs folder', ['marketing', 'runs']],
    ['the run folder', ['marketing', 'runs', 'run-a']],
    ['the artifacts folder', ['marketing', 'runs', 'run-a', 'artifacts']],
  ])('refuses a symlink swapped in for %s', async (_, segments) => {
    const root = await tempDir('lousho-artifacts-');
    const outside = await tempDir('lousho-outside-');
    await mkdir(join(root, ...segments.slice(0, -1)), { recursive: true });
    await symlink(outside, join(root, ...segments));
    const store = fileArtifactStore(root);
    await expect(store.put(page, 'a.md', 'x', 'text/plain')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_UNSAFE_PATH' });
    await expect(store.get('artifact://marketing/run-a/a.md', page)).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_UNSAFE_PATH' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses an artifact file swapped for a symlink', async () => {
    const root = await tempDir('lousho-artifacts-');
    const outside = await tempDir('lousho-outside-');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    const store = fileArtifactStore(root);
    const ref = await store.put(page, 'a.md', 'mine', 'text/plain');
    const file = join(root, 'marketing', 'runs', 'run-a', 'artifacts', 'a.md');
    await rm(file);
    await symlink(join(outside, 'secret.txt'), file);
    await expect(store.get(ref.uri, page)).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_UNSAFE_PATH' });
    await expect(store.put(page, 'a.md', 'mine', 'text/plain')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_UNSAFE_PATH' });
    await symlink(join(outside, 'secret.txt'), join(root, 'marketing', 'runs', 'run-a', 'artifacts', 'b.md'));
    await expect(store.put(page, 'b.md', 'overwrite', 'text/plain')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_UNSAFE_PATH' });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('accepts a root that is itself reached through a symlink', async () => {
    const real = await tempDir('lousho-artifacts-');
    const parent = await tempDir('lousho-link-');
    await symlink(real, join(parent, 'root'));
    const store = fileArtifactStore(join(parent, 'root'));
    const ref = await store.put(page, 'a.md', 'x', 'text/plain');
    expect((await store.get(ref.uri, page))?.ref).toEqual(ref);
  });

  it('stores a run id and a name of 255 bytes', async () => {
    const root = await tempDir('lousho-artifacts-');
    const scope = { workspace: 'marketing', runId: 'r'.repeat(255) };
    const name = `${'é'.repeat(125)}.mdx`;
    expect(new TextEncoder().encode(name).length).toBe(254);
    const longest = `${name}x`;
    const store = fileArtifactStore(root);
    const ref = await store.put(scope, longest, 'long', 'text/markdown');
    expect(new TextDecoder().decode((await store.get(ref.uri, scope))?.data)).toBe('long');
    await expect(store.put(scope, `${longest}x`, 'long', 'text/markdown')).rejects.toBeInstanceOf(ValidationError);
  });

  it('never returns an artifact recorded under another run or name', async () => {
    const root = await tempDir('lousho-artifacts-');
    const store = fileArtifactStore(root);
    await store.put(page, 'a.md', 'x', 'text/plain');
    const meta = join(root, 'marketing', 'runs', 'run-a', 'artifact-meta', 'a.md');
    const recorded = JSON.parse(await readFile(meta, 'utf8')) as Record<string, unknown>;
    await writeFile(meta, JSON.stringify({ ...recorded, runId: 'run-b' }));
    expect(await store.get('artifact://marketing/run-a/a.md', page)).toBeUndefined();
    await writeFile(meta, 'not json');
    expect(await store.get('artifact://marketing/run-a/a.md', page)).toBeUndefined();
  });

  it('records metadata again for content a crash left without it', async () => {
    const root = await tempDir('lousho-artifacts-');
    const store = fileArtifactStore(root);
    const ref = await store.put(page, 'a.md', 'x', 'text/plain');
    await rm(join(root, 'marketing', 'runs', 'run-a', 'artifact-meta', 'a.md'));
    expect(await store.get(ref.uri, page)).toBeUndefined();
    await expect(store.put(page, 'a.md', 'y', 'text/plain')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_EXISTS' });
    expect(await store.put(page, 'a.md', 'x', 'text/plain')).toEqual(ref);
    expect((await store.get(ref.uri, page))?.ref).toEqual(ref);
  });

  it('returns undefined when the root does not exist yet', async () => {
    const parent = await tempDir('lousho-artifacts-');
    expect(await fileArtifactStore(join(parent, 'missing')).get('artifact://marketing/run-a/a.md', page)).toBeUndefined();
  });
  it('refuses a name that shares its file with another name on a case-insensitive disk', async () => {
    const root = await tempDir('lousho-artifacts-');
    const store = fileArtifactStore(root);
    const first = await store.put(page, 'Plan.md', 'v1', 'text/markdown');
    if (await ignoresCase(root)) {
      await expect(store.put(page, 'plan.md', 'v1', 'text/markdown')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_EXISTS' });
      await expect(store.put(page, 'plan.md', 'other', 'text/markdown')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_EXISTS' });
      expect(await store.get('artifact://marketing/run-a/plan.md', page)).toBeUndefined();
    } else {
      const second = await store.put(page, 'plan.md', 'v2', 'text/markdown');
      expect(new TextDecoder().decode((await store.get(second.uri, page))?.data)).toBe('v2');
    }
    expect(new TextDecoder().decode((await store.get(first.uri, page))?.data)).toBe('v1');
  });

  it('refuses a run folder whose name differs from the run id only in case', async () => {
    const root = await tempDir('lousho-artifacts-');
    const store = fileArtifactStore(root);
    const upper = { workspace: 'marketing', runId: 'A' };
    const lower = { workspace: 'marketing', runId: 'a' };
    const ref = await store.put(upper, 'x.md', 'upper', 'text/markdown');
    if (await ignoresCase(root)) {
      await expect(store.put(lower, 'x.md', 'upper', 'text/markdown')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_UNSAFE_PATH' });
      await expect(store.get('artifact://marketing/a/x.md', lower)).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_UNSAFE_PATH' });
    } else {
      expect((await store.put(lower, 'x.md', 'lower', 'text/markdown')).sha256).not.toBe(ref.sha256);
    }
    expect(new TextDecoder().decode((await store.get(ref.uri, upper))?.data)).toBe('upper');
  });

  it.each(['EPERM', 'ENOTSUP', 'EXDEV'])('fails closed with LOUSHO_STORAGE_FAILED when hard links fail with %s', async (code) => {
    const root = await tempDir('lousho-artifacts-');
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    await expect(fileArtifactStore(root).put(page, 'a.md', 'x', 'text/plain')).rejects.toMatchObject({ code: 'LOUSHO_STORAGE_FAILED' });
    expect(await readdir(join(root, 'marketing', 'runs', 'run-a', 'artifacts'))).toEqual([]);
    expect(await fileArtifactStore(root).get('artifact://marketing/run-a/a.md', page)).toBeUndefined();
  });
});
