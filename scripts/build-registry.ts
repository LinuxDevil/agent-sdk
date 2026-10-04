// fallow-ignore-file complexity
/**
 * build-registry (M7b)
 *
 * Builds `registry/dist/` - the static JSON `lousho add` reads by default -
 * from the `registry/<name>/` source folders. Each folder holds an `item.json`
 * (name, type, description, permissions, dependencies) and the item's files;
 * a file's path inside the folder is the path `lousho add` gives it in the
 * agent directory (`tools/x.ts`, `skills/<name>/SKILL.md`, `channels/x.ts`).
 *
 * Every item is validated the way `lousho add` will validate it: `item.json`
 * and the assembled document against `ItemSchema` of src/cli/registry.ts, the
 * written paths against the same rules as addWrite.planFiles, and the code
 * against the manifest with addCheck.checkItem (a `refuse` finding fails the
 * build). The index is checked against `IndexSchema`. Output is deterministic
 * (items sorted by name, files by path, LF endings), so `--check` behaves the
 * same on Windows and Linux.
 *
 * Usage:
 *   npx tsx scripts/build-registry.ts           write registry/dist
 *   npx tsx scripts/build-registry.ts --check   exit 1 when registry/dist is stale
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkItem, formatFinding } from '../src/cli/addCheck';
import { planFiles } from '../src/cli/addWrite';
import { IndexSchema, ItemSchema, type RegistryIndex, type RegistryItem } from '../src/cli/registry';
import { issueMessage, issuePath } from '../src/utils/zodCompat';
import { normalizeNewlines } from './llmsTxt';

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'registry');
const DIST_DIR = path.join(SOURCE_DIR, 'dist');
const INDEX_FILE = 'index.json';
const ITEMS_DIR = 'items';

/** item.json is ItemSchema without `files` (they come from the folder); unknown keys are rejected. */
const ManifestSchema = ItemSchema.omit({ files: true }).strict();

function fail(message: string): never {
  console.error(`registry build: ${message}`);
  process.exit(1);
}

/** Every file under `dir`, as forward-slashed paths relative to `dir`, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The validation problems of `parsed`, formatted like the CLI reports them. */
function problems(parsed: { error: { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> } }): string {
  return parsed.error.issues.map((issue) => `${issuePath(issue)}: ${issueMessage(issue)}`).join('; ');
}

/** Reads and validates `registry/<name>/`; fails the build on the first problem. */
function buildItem(name: string): RegistryItem {
  const dir = path.join(SOURCE_DIR, name);
  const manifestFile = path.join(dir, 'item.json');
  if (!fs.existsSync(manifestFile)) fail(`${name}: no item.json (every registry/<name>/ folder needs one)`);
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    fail(`${name}/item.json is not valid JSON (${(error as Error).message})`);
  }
  const manifest = ManifestSchema.safeParse(json);
  if (!manifest.success) fail(`${name}/item.json: ${problems(manifest)}`);
  if (manifest.data.name !== name) fail(`${name}/item.json: name '${manifest.data.name}' does not match its folder name`);

  const files = listFiles(dir)
    .filter((file) => file !== 'item.json')
    .map((file) => ({ path: file, content: normalizeNewlines(fs.readFileSync(path.join(dir, file), 'utf8')) }));
  const parsed = ItemSchema.safeParse({ ...manifest.data, files });
  if (!parsed.success) fail(`${name}: ${problems(parsed)}`);
  const item = parsed.data;
  // The same folder/size rules lousho add applies (the agent dir argument is
  // only used to build absolute paths, which the check does not inspect).
  planFiles(item, dir);
  const refused = checkItem(item).filter((finding) => finding.level === 'refuse');
  if (refused.length > 0) fail(`'${name}' does not match its permission manifest:\n${refused.map(formatFinding).join('\n')}`);
  return item;
}

/** The files registry/dist should contain, path -> content. */
function build(): Map<string, string> {
  const names = fs
    .readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'dist')
    .map((entry) => entry.name)
    .sort();
  const items = names.map(buildItem);
  const index: RegistryIndex = {
    items: items.map((item) => ({ name: item.name, type: item.type, description: item.description, path: `${ITEMS_DIR}/${item.name}.json` })),
  };
  const parsedIndex = IndexSchema.safeParse(index);
  if (!parsedIndex.success) fail(`the generated index is invalid: ${problems(parsedIndex)}`);

  const outputs = new Map<string, string>();
  outputs.set(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
  for (const item of items) outputs.set(`${ITEMS_DIR}/${item.name}.json`, `${JSON.stringify(item, null, 2)}\n`);
  return outputs;
}

/** The files registry/dist does contain, path -> normalized content. */
function onDisk(): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(DIST_DIR)) return files;
  for (const file of listFiles(DIST_DIR)) files.set(file, normalizeNewlines(fs.readFileSync(path.join(DIST_DIR, file), 'utf8')));
  return files;
}

function check(outputs: Map<string, string>): void {
  const disk = onDisk();
  const stale: string[] = [];
  for (const [file, content] of outputs) if (disk.get(file) !== content) stale.push(file);
  for (const file of disk.keys()) if (!outputs.has(file)) stale.push(`${file} (no source)`);
  if (stale.length > 0) {
    console.error(`registry/dist is stale: run npm run registry:build (out of date: ${stale.sort().join(', ')})`);
    process.exit(1);
  }
}

const outputs = build();
if (process.argv.includes('--check')) {
  check(outputs);
} else {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  for (const [file, content] of outputs) {
    const target = path.join(DIST_DIR, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  console.log(`registry/dist: index.json plus ${outputs.size - 1} item document(s) written`);
}
