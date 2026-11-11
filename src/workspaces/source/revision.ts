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

export function checkPath(path: string): string {
  if (path === '' || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) throw invalidPath(path, 'must be a relative path with forward slashes');
  const segments = path.split('/');
  if (segments.some(badSegment)) throw invalidPath(path, "must not have empty, '.' or '..' segments");
  if (IGNORED_ROOTS.has(segments[0])) throw invalidPath(path, `is inside ${segments[0]}/, which a workspace source never reads or writes`);
  return path;
}

export function isIgnored(path: string): boolean {
  return IGNORED_ROOTS.has(path.split('/')[0]);
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
  const revision = revisionId(next);
  if (revision === head) throw new NoChangeError(head);
  return { files: next, revision };
}
