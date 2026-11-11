import { createHash } from 'node:crypto';
import { SDKError, ValidationError } from '../../execution/errors';
import { formatArtifactUri, parseArtifactUri, type ArtifactData, type ArtifactRef, type ArtifactSink, type ArtifactUriParts } from '../contracts/execution';

/** Who is reading or writing artifacts: one run of one workspace, plus the artifact uris handed to it as refs. */
export interface ArtifactScope {
  /** The caller's workspace id. */
  workspace: string;
  /** The caller's run id; its own artifacts live under it. */
  runId: string;
  /** Artifact uris of other runs that came back to this run as refs (through the main agent), which it may also read. */
  refs?: readonly string[];
}

/** An artifact read back from a store. */
export interface StoredArtifact {
  /** The artifact's reference, with the uri in its canonical form. */
  ref: ArtifactRef;
  /** The artifact's content. */
  data: Uint8Array;
}

/** Where page runs keep their artifacts; the host injects one (R17). */
export interface ArtifactStore {
  /** Stores one artifact of the run in `scope`; storing the same name again succeeds only with the same content and media type. */
  put(scope: ArtifactScope, name: string, data: ArtifactData, mediaType: string): Promise<ArtifactRef>;
  /** Reads an artifact, or `undefined` when there is none; throws `LOUSHO_ARTIFACT_FORBIDDEN` when the uri is outside `scope`. */
  get(uri: string, scope: ArtifactScope): Promise<StoredArtifact | undefined>;
}

/** Options every artifact store takes. */
export interface ArtifactStoreOptions {
  /** Largest artifact accepted, in bytes; 200 MiB by default. */
  maxArtifactBytes?: number;
}

/** A stored blob's metadata, as `BlobClient.head` returns it. */
export interface BlobHead {
  /** Size in bytes. */
  bytes: number;
  /** The metadata stored with the blob. */
  metadata: Readonly<Record<string, string>>;
}

/** A stored blob, as `BlobClient.get` returns it. */
export interface BlobObject {
  /** The blob's content. */
  data: Uint8Array;
  /** The metadata stored with the blob. */
  metadata: Readonly<Record<string, string>>;
}

/** Options of `BlobClient.put`. */
export interface BlobPutOptions {
  /** Store only when no blob exists under the key (a conditional put). */
  ifAbsent?: boolean;
}

/** The blob storage a host backs `blobArtifactStore` with (D27). */
export interface BlobClient {
  /** Stores `data` with `metadata` under `key`; with `ifAbsent` it stores only when the key is absent and resolves `false` otherwise, and a host that cannot honour `ifAbsent` must throw rather than overwrite an existing key. */
  put(key: string, data: Uint8Array, metadata: Readonly<Record<string, string>>, options?: BlobPutOptions): Promise<boolean | void>;
  /** Reads the blob under `key`, or `undefined` when there is none. */
  get(key: string): Promise<BlobObject | undefined>;
  /** Reads the size and metadata of the blob under `key`, or `undefined` when there is none. */
  head(key: string): Promise<BlobHead | undefined>;
}

const DEFAULT_MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

const MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[ -~]*)?$/;

const MAX_MEDIA_TYPE_LENGTH = 255;

const utf8 = new TextEncoder();

export function maxArtifactBytes(options: ArtifactStoreOptions): number {
  return options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
}

function checkMediaType(mediaType: string): void {
  if (mediaType.length <= MAX_MEDIA_TYPE_LENGTH && MEDIA_TYPE.test(mediaType)) return;
  throw new ValidationError(`invalid artifact media type ${JSON.stringify(mediaType)}`, { mediaType: ['must be a media type such as text/markdown'] });
}

export function artifactTarget(scope: ArtifactScope, name: string, mediaType: string): { parts: ArtifactUriParts; uri: string } {
  const parts = { workspace: scope.workspace, runId: scope.runId, name };
  const uri = formatArtifactUri(parts);
  checkMediaType(mediaType);
  return { parts, uri };
}

export function scopedParts(uri: string, scope: ArtifactScope): ArtifactUriParts {
  const parts = parseArtifactUri(uri);
  if (!parts) throw new ValidationError(`invalid artifact uri ${JSON.stringify(uri)}`, { uri: ['must be artifact://<workspace>/<runId>/<name>'] });
  if (inScope(parts, scope)) return parts;
  throw new SDKError(`artifact ${JSON.stringify(uri)} is outside run ${JSON.stringify(scope.runId)} of workspace ${JSON.stringify(scope.workspace)}`, 'LOUSHO_ARTIFACT_FORBIDDEN');
}

function inScope(parts: ArtifactUriParts, scope: ArtifactScope): boolean {
  return parts.workspace === scope.workspace && (parts.runId === scope.runId || isGranted(parts, scope));
}

function isGranted(parts: ArtifactUriParts, scope: ArtifactScope): boolean {
  return (scope.refs ?? []).some((ref) => sameParts(parseArtifactUri(ref), parts));
}

function sameParts(a: ArtifactUriParts | undefined, b: ArtifactUriParts): boolean {
  return a !== undefined && a.workspace === b.workspace && a.runId === b.runId && a.name === b.name;
}

function toBytes(chunk: unknown): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : utf8.encode(String(chunk));
}

async function* chunksOf(data: ArtifactData): AsyncIterable<Uint8Array> {
  if (typeof data === 'string' || data instanceof Uint8Array) {
    yield toBytes(data);
    return;
  }
  for await (const chunk of data) yield toBytes(chunk);
}

interface MeasuredContent {
  sha256: string;
  bytes: number;
}

function tooLarge(max: number): SDKError {
  return new SDKError(`artifact is larger than maxArtifactBytes (${max} bytes)`, 'LOUSHO_ARTIFACT_TOO_LARGE');
}

export async function consumeArtifact(data: ArtifactData, max: number, write: (chunk: Uint8Array) => Promise<void> | void): Promise<MeasuredContent> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of chunksOf(data)) {
    bytes += chunk.byteLength;
    if (bytes > max) throw tooLarge(max);
    hash.update(chunk);
    await write(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}

export function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sameOrExisting(existing: ArtifactRef, next: ArtifactRef): ArtifactRef {
  if (existing.sha256 === next.sha256 && existing.mediaType === next.mediaType) return existing;
  throw new SDKError(`artifact ${JSON.stringify(next.uri)} already exists with other content or another media type`, 'LOUSHO_ARTIFACT_EXISTS');
}

/** Hands an engine or tool the `ArtifactSink` of one run: every put lands in that run's scope. */
export function artifactSink(store: ArtifactStore, scope: ArtifactScope): ArtifactSink {
  return { put: (name, data, mediaType) => store.put(scope, name, data, mediaType) };
}

function blobKey(parts: ArtifactUriParts): string {
  return `${parts.workspace}/runs/${parts.runId}/artifacts/${parts.name}`;
}

function concat(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function blobRef(parts: ArtifactUriParts, head: BlobHead, data?: Uint8Array): ArtifactRef {
  return {
    name: parts.name,
    mediaType: head.metadata.mediaType ?? 'application/octet-stream',
    uri: formatArtifactUri(parts),
    bytes: head.bytes,
    sha256: head.metadata.sha256 ?? (data ? sha256Of(data) : ''),
  };
}

async function existingBlobRef(client: BlobClient, key: string, parts: ArtifactUriParts, next: ArtifactRef): Promise<ArtifactRef> {
  const head = await client.head(key);
  if (!head) throw new SDKError(`artifact ${JSON.stringify(next.uri)} was refused by the blob store but is not there`, 'LOUSHO_STORAGE_FAILED');
  return sameOrExisting(blobRef(parts, head), next);
}

/** An artifact store over a host's blob storage: keys are `<workspace>/runs/<runId>/artifacts/<name>`, with `sha256` and `mediaType` stored as metadata. */
export function blobArtifactStore(client: BlobClient, options: ArtifactStoreOptions = {}): ArtifactStore {
  const max = maxArtifactBytes(options);
  return {
    async put(scope, name, data, mediaType) {
      const { parts, uri } = artifactTarget(scope, name, mediaType);
      const chunks: Uint8Array[] = [];
      const measured = await consumeArtifact(data, max, (chunk) => {
        chunks.push(chunk);
      });
      const ref: ArtifactRef = { name, mediaType, uri, ...measured };
      const key = blobKey(parts);
      const existing = await client.head(key);
      if (existing) return sameOrExisting(blobRef(parts, existing), ref);
      const stored = await client.put(key, concat(chunks, measured.bytes), { sha256: measured.sha256, mediaType }, { ifAbsent: true });
      return stored === false ? existingBlobRef(client, key, parts, ref) : ref;
    },
    async get(uri, scope) {
      const parts = scopedParts(uri, scope);
      const object = await client.get(blobKey(parts));
      if (!object) return undefined;
      return { ref: blobRef(parts, { bytes: object.data.byteLength, metadata: object.metadata }, object.data), data: object.data };
    },
  };
}

/** A `BlobClient` that keeps blobs in memory, for tests and hosts with no filesystem. */
export function memoryBlobClient(): BlobClient {
  const blobs = new Map<string, BlobObject>();
  return {
    put(key, data, metadata, options) {
      if (options?.ifAbsent && blobs.has(key)) return Promise.resolve(false);
      blobs.set(key, { data: data.slice(), metadata: { ...metadata } });
      return Promise.resolve(true);
    },
    get(key) {
      const blob = blobs.get(key);
      return Promise.resolve(blob && { data: blob.data.slice(), metadata: { ...blob.metadata } });
    },
    head(key) {
      const blob = blobs.get(key);
      return Promise.resolve(blob && { bytes: blob.data.byteLength, metadata: { ...blob.metadata } });
    },
  };
}

/** An artifact store that keeps artifacts in memory, for tests and hosts with no filesystem. */
export function memoryArtifactStore(options: ArtifactStoreOptions = {}): ArtifactStore {
  return blobArtifactStore(memoryBlobClient(), options);
}
