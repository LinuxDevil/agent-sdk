/**
 * The install receipt of `lousho add` (M7a): `<agent-dir>/lousho-registry.json`
 * records each installed item's type, registry, install time, permission
 * manifest and the sha256 of every file written, so later tooling can tell
 * what came from a registry and whether it was edited since.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { SDKError } from '../execution/errors';
import type { PlannedFile } from './addWrite';
import type { RegistryItem } from './registry';

export const RECEIPT_FILE = 'lousho-registry.json';

export interface ReceiptEntry {
  type: RegistryItem['type'];
  registry: string;
  installedAt: string;
  permissions: RegistryItem['permissions'];
  files: { path: string; sha256: string }[];
}

export interface Receipt {
  v: 1;
  items: Record<string, ReceiptEntry>;
}

const sha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
}

function invalid(file: string, reason: string): SDKError {
  return new SDKError(`lousho add: ${file} is not a valid install receipt: ${reason}`, 'LOUSHO_REGISTRY_INVALID', {
    hint: `Fix or remove ${RECEIPT_FILE}; lousho add writes it after each install.`,
  });
}

/**
 * Reads the receipt in `agentDir` (an empty one when there is none). Call before
 * writing any file: a receipt that is not valid JSON, or a symlink, stops the install.
 */
export async function readReceipt(agentDir: string): Promise<Receipt> {
  const file = path.join(agentDir, RECEIPT_FILE);
  const stats = await lstat(file).catch(() => undefined);
  if (!stats) return { v: 1, items: {} };
  if (!stats.isFile()) throw new SDKError(`lousho add: ${RECEIPT_FILE} in ${agentDir} is not a regular file (a symlink or a folder).`, 'LOUSHO_REGISTRY_UNSAFE_PATH');
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw invalid(file, error instanceof Error ? error.message : String(error));
  }
  const receipt = json as Partial<Receipt> | null;
  if (receipt?.v !== 1 || typeof receipt.items !== 'object' || receipt.items === null || Array.isArray(receipt.items)) throw invalid(file, 'expected { "v": 1, "items": { ... } }.');
  return { v: 1, items: receipt.items };
}

/** Adds (or replaces) `item`'s entry and writes the receipt with sorted keys. */
export async function writeReceipt(agentDir: string, receipt: Receipt, item: RegistryItem, files: PlannedFile[], registry: string, now: Date = new Date()): Promise<Receipt> {
  const entry: ReceiptEntry = {
    type: item.type,
    registry,
    installedAt: now.toISOString(),
    permissions: item.permissions,
    files: files.map((file) => ({ path: file.relative, sha256: sha256(file.content) })),
  };
  const next: Receipt = { v: 1, items: { ...receipt.items, [item.name]: entry } };
  await writeFile(path.join(agentDir, RECEIPT_FILE), `${JSON.stringify(sortKeys(next), null, 2)}\n`, 'utf8');
  return next;
}
