/**
 * Workspace ids and refs.
 *
 * A workspace id must be stable enough to put in a URL (`?ws=<id>`, the
 * client sends it on every API request) and unique enough to distinguish
 * two folders with the same basename, so it is a readable slug of the
 * folder's name plus a short hash of its canonical path. Same folder
 * opened two ways (`/x`, `/x/`, `/x/a/..`) gets the same id.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceRef } from '../../shared/workspace';

/**
 * `name` as a url-safe slug: lowercase, runs of non `[a-z0-9]` collapsed
 * to `-`, trimmed, capped at 40 chars without a dangling `-`; an empty
 * result becomes `'workspace'` so an odd basename still produces an id.
 */
export function workspaceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'workspace';
}

/**
 * The canonical form of `root`: `realpath` (`.native`, which returns the
 * on-disk letter case on Windows so `e:\x` and `E:\x` hash the same) over
 * the absolute path; just the absolute path when the folder doesn't exist
 * (a workspace can be registered for a folder yet to be created).
 */
export function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** `slug(basename(canonicalRoot(root))) + '-' + sha256(canonicalRoot(root)).slice(0, 6)` - matches `WORKSPACE_ID_RE`. */
export function workspaceIdFor(root: string): string {
  const canonical = canonicalRoot(root);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 6);
  return `${workspaceSlug(path.basename(canonical))}-${hash}`;
}

/**
 * A fresh `WorkspaceRef` for `root` (the registry record routes resolve a
 * workspace by): `name` is the folder's basename - or the canonical path
 * itself for a drive root, whose basename is empty - and both timestamps
 * are `now` (defaults to the current time).
 */
export function workspaceRefFor(root: string, now?: Date): WorkspaceRef {
  const canonical = canonicalRoot(root);
  const at = (now ?? new Date()).toISOString();
  return {
    id: workspaceIdFor(root),
    name: path.basename(canonical) || canonical,
    root: canonical,
    addedAt: at,
    lastOpenedAt: at,
  };
}
