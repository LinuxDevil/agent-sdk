import { createHash } from 'node:crypto';
import { invalidPath, NoChangeError, StaleRevisionError } from './errors';
import type { RevisionId, RevisionMeta, SourceWriteOptions, WorkspaceChanges } from './types';

export const SOURCE_DIR = '.lousho';

const IGNORED_ROOTS = new Set([SOURCE_DIR, 'node_modules', '.git']);

export type FileMap = ReadonlyMap<string, string>;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function contentHash(content: string): string {
  return sha256(content);
}

export function revisionId(files: FileMap): RevisionId {
  const lines = [...files.keys()].sort().map((path) => `${path}\0${contentHash(files.get(path) ?? '')}\n`);
  return sha256(lines.join(''));
}

function badSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..' || segment.includes('\0');
}

function foldPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function reservedSegment(path: string): string | undefined {
  return foldPath(path).split('/').find((segment) => IGNORED_ROOTS.has(segment));
}

export function checkPath(path: string): string {
  if (path === '' || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) throw invalidPath(path, 'must be a relative path with forward slashes');
  if (path.split('/').some(badSegment)) throw invalidPath(path, "must not have empty, '.' or '..' segments");
  const reserved = reservedSegment(path);
  if (reserved !== undefined) throw invalidPath(path, `is inside ${reserved}/, which a workspace source never reads or writes`);
  return path;
}

function folderPrefixes(key: string): string[] {
  const segments = key.split('/');
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function foldedKeys(files: FileMap): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const path of files.keys()) {
    const other = byKey.get(foldPath(path));
    if (other !== undefined) throw invalidPath(path, `clashes with '${other}' (the same path after Unicode normalisation and case folding)`);
    byKey.set(foldPath(path), path);
  }
  return byKey;
}

export function checkTree(files: FileMap): void {
  const byKey = foldedKeys(files);
  for (const [key, path] of byKey) {
    const folder = folderPrefixes(key).find((prefix) => byKey.has(prefix));
    if (folder !== undefined) throw invalidPath(path, `needs '${byKey.get(folder)}' to be a folder, but it is a file`);
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed === '' ? '' : checkPath(trimmed);
}

function underPrefix(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

export function listFiles(files: FileMap, prefix: string): string[] {
  const folder = normalizePrefix(prefix);
  return [...files.keys()].filter((path) => underPrefix(path, folder)).sort();
}

export function applyChanges(files: FileMap, changes: WorkspaceChanges): Map<string, string> {
  const next = new Map(files);
  for (const [path, content] of Object.entries(changes)) {
    checkPath(path);
    if (content === null) next.delete(path);
    else next.set(path, content);
  }
  return next;
}

export function revisionMeta(seq: number, revision: RevisionId, parent: RevisionId, options: SourceWriteOptions): RevisionMeta {
  const meta: RevisionMeta = { seq, revision, parent, createdAt: new Date().toISOString(), by: options.by, message: options.message, kind: options.kind ?? 'authoring' };
  return options.audit === undefined ? meta : { ...meta, audit: options.audit };
}

export function nextTree(files: FileMap, head: RevisionId, changes: WorkspaceChanges, options: SourceWriteOptions): { files: Map<string, string>; revision: RevisionId } {
  if (options.expectedRevision !== head) throw new StaleRevisionError(options.expectedRevision, head);
  const next = applyChanges(files, changes);
  checkTree(next);
  const revision = revisionId(next);
  if (revision === head) throw new NoChangeError(head);
  return { files: next, revision };
}
