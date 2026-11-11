import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SDKError } from '../../execution/errors';
import { syncDirectory } from '../../storage/atomicFile';
import { formatArtifactUri, type ArtifactRef, type ArtifactUriParts } from '../contracts/execution';
import { checkMediaType, consumeArtifact, maxArtifactBytes, sameOrExisting, scopedParts, sha256Of, type ArtifactStore, type ArtifactStoreOptions } from './artifacts';

const ARTIFACTS_DIR = 'artifacts';

const META_DIR = 'artifact-meta';

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

interface RunDirs {
  artifacts: string;
  meta: string;
}

const metaSchema = z.object({
  workspace: z.string(),
  runId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  bytes: z.number(),
  sha256: z.string(),
});

type ArtifactMeta = z.infer<typeof metaSchema>;

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function unsafePath(path: string): SDKError {
  return new SDKError(`artifact store path ${JSON.stringify(path)} is not a plain folder or file inside the store root`, 'LOUSHO_ARTIFACT_UNSAFE_PATH');
}

async function lstatOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function plainDir(dir: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(dir).catch((error: unknown) => {
    if (errnoCode(error) !== 'EEXIST') throw error;
  });
  const stat = await lstatOrUndefined(dir);
  if (!stat) return false;
  if (!stat.isDirectory()) throw unsafePath(dir);
  return true;
}

async function walk(base: string, segments: readonly string[], create: boolean): Promise<string | undefined> {
  let dir = base;
  for (const segment of segments) {
    dir = join(dir, segment);
    if (!(await plainDir(dir, create))) return undefined;
  }
  return dir;
}

async function realRoot(root: string, create: boolean): Promise<string | undefined> {
  if (create) await mkdir(root, { recursive: true });
  try {
    return await realpath(root);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function runDirs(root: string, parts: ArtifactUriParts, create: boolean): Promise<RunDirs | undefined> {
  const base = await realRoot(root, create);
  const run = base === undefined ? undefined : await walk(base, [parts.workspace, 'runs', parts.runId], create);
  if (run === undefined) return undefined;
  const artifacts = await walk(run, [ARTIFACTS_DIR], create);
  const meta = await walk(run, [META_DIR], create);
  return artifacts !== undefined && meta !== undefined ? { artifacts, meta } : undefined;
}

async function readPlainFile(file: string): Promise<Uint8Array | undefined> {
  const stat = await lstatOrUndefined(file);
  if (!stat) return undefined;
  if (!stat.isFile()) throw unsafePath(file);
  let handle;
  try {
    handle = await open(file, READ_FLAGS);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    if (errnoCode(error) === 'ELOOP') throw unsafePath(file);
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw unsafePath(file);
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function readMeta(dirs: RunDirs, parts: ArtifactUriParts): Promise<ArtifactMeta | undefined> {
  const raw = await readPlainFile(join(dirs.meta, parts.name));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
  const meta = metaSchema.safeParse(parsed);
  if (!meta.success) return undefined;
  const sameArtifact = meta.data.workspace === parts.workspace && meta.data.runId === parts.runId && meta.data.name === parts.name;
  return sameArtifact ? meta.data : undefined;
}

function refOf(parts: ArtifactUriParts, meta: Pick<ArtifactMeta, 'mediaType' | 'bytes' | 'sha256'>): ArtifactRef {
  return { name: parts.name, mediaType: meta.mediaType, uri: formatArtifactUri(parts), bytes: meta.bytes, sha256: meta.sha256 };
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset)).bytesWritten;
}

async function writeTemp(temp: string, write: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>): Promise<void> {
  const handle = await open(temp, 'wx');
  try {
    await write(handle);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function linkNew(temp: string, file: string): Promise<boolean> {
  try {
    await link(temp, file);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw error;
  }
}

async function writeMeta(dirs: RunDirs, parts: ArtifactUriParts, ref: ArtifactRef): Promise<void> {
  const meta: ArtifactMeta = { workspace: parts.workspace, runId: parts.runId, name: parts.name, mediaType: ref.mediaType, bytes: ref.bytes, sha256: ref.sha256 };
  const temp = join(dirs.meta, `.tmp-${randomUUID()}`);
  try {
    await writeTemp(temp, (handle) => writeAll(handle, new TextEncoder().encode(JSON.stringify(meta))));
    await rename(temp, join(dirs.meta, parts.name));
  } finally {
    await rm(temp, { force: true });
  }
  await syncDirectory(dirs.meta);
}

async function existingRef(dirs: RunDirs, parts: ArtifactUriParts, next: ArtifactRef): Promise<ArtifactRef> {
  const data = await readPlainFile(join(dirs.artifacts, parts.name));
  if (!data) throw unsafePath(join(dirs.artifacts, parts.name));
  const meta = await readMeta(dirs, parts);
  if (meta) return sameOrExisting(refOf(parts, meta), next);
  const found = sameOrExisting({ ...next, bytes: data.byteLength, sha256: sha256Of(data) }, next);
  await writeMeta(dirs, parts, found);
  return found;
}

/** An artifact store on local disk (D27): `<root>/<workspace>/runs/<runId>/artifacts/<name>`, written atomically and never through a symlink. */
export function fileArtifactStore(root: string, options: ArtifactStoreOptions = {}): ArtifactStore {
  const max = maxArtifactBytes(options);
  return {
    async put(scope, name, data, mediaType) {
      const parts = { workspace: scope.workspace, runId: scope.runId, name };
      const uri = formatArtifactUri(parts);
      checkMediaType(mediaType);
      const dirs = await runDirs(root, parts, true);
      if (!dirs) throw unsafePath(root);
      const temp = join(dirs.artifacts, `.tmp-${randomUUID()}`);
      try {
        let measured = { sha256: '', bytes: 0 };
        await writeTemp(temp, async (handle) => {
          measured = await consumeArtifact(data, max, (chunk) => writeAll(handle, chunk));
        });
        const ref: ArtifactRef = { name, mediaType, uri, ...measured };
        if (!(await linkNew(temp, join(dirs.artifacts, name)))) return await existingRef(dirs, parts, ref);
        await writeMeta(dirs, parts, ref);
        await syncDirectory(dirs.artifacts);
        return ref;
      } finally {
        await rm(temp, { force: true });
      }
    },
    async get(uri, scope) {
      const parts = scopedParts(uri, scope);
      const dirs = await runDirs(root, parts, false);
      const meta = dirs && (await readMeta(dirs, parts));
      const data = dirs && meta && (await readPlainFile(join(dirs.artifacts, parts.name)));
      return meta && data ? { ref: refOf(parts, meta), data } : undefined;
    },
  };
}
