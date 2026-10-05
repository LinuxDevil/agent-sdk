/**
 * The committed default registry (M7b): `registry/dist/index.json` plus one
 * document per item, built by `npm run registry:build`. Every document is
 * schema-valid, every item installs with `runAdd` into a temp agent directory
 * and the directory then loads the way `lousho dev` would load it. Nothing
 * here touches the network: the index and item documents are read from disk
 * and the tools, skills and channel are only loaded, never executed (no
 * request is made; WEBHOOK_SECRET is set only so the channel module loads).
 *
 * `resolveAgentDir` is imported from the package (`@lousho/build-ai-agent`,
 * i.e. dist/) on purpose: the installed item files import the SDK by that
 * name, and a defineTool() tool is only recognized when the file and the
 * loader share one copy of the SDK — loading the directory through src/ would
 * be a second copy. This is also why the test needs `npm run build` to have
 * run, as in CI. The temp agent directory sits inside the repository so its
 * `zod` and `@lousho/build-ai-agent` imports resolve like a real project's
 * (self-reference to the built package, node_modules for zod).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { resolveAgentDir } from '@lousho/build-ai-agent';
import { runAdd } from './add';
import { IndexSchema, ItemSchema } from './registry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'registry', 'dist');
const INDEX = path.join(DIST, 'index.json');

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

let root: string;
let agentDir: string;

async function add(args: string[]) {
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  stdin.end('');
  const out = sink();
  const err = sink();
  const code = await runAdd(args, { stdin, stdout: out.stream, stderr: err.stream, cwd: root, env: {} });
  return { code, out: out.text(), err: err.text() };
}

beforeEach(() => {
  // Inside the repository so the installed files' `zod` and
  // `@lousho/build-ai-agent` imports resolve (see the comment at the top).
  root = fs.mkdtempSync(path.join(REPO_ROOT, '.lousho-default-registry-'));
  agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'instructions.md'), 'You help the user.');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('default registry (registry/dist)', () => {
  it('has a schema-valid index and schema-valid item documents', () => {
    const index = IndexSchema.parse(JSON.parse(fs.readFileSync(INDEX, 'utf8')));
    expect(index.items.map((item) => item.name)).toEqual([
      'changelog',
      'code-review',
      'coding-kit',
      'generic-webhook',
      'github-issues',
      'open-meteo-weather',
    ]);
    for (const entry of index.items) {
      const document = path.join(DIST, entry.path as string);
      expect(fs.existsSync(document), `${entry.name}: ${entry.path}`).toBe(true);
      const item = ItemSchema.parse(JSON.parse(fs.readFileSync(document, 'utf8')));
      expect(item.name).toBe(entry.name);
      expect(item.type).toBe(entry.type);
    }
  });

  it('installs every item and the agent directory loads', async () => {
    const index = IndexSchema.parse(JSON.parse(fs.readFileSync(INDEX, 'utf8')));
    for (const entry of index.items) {
      // A kit is a whole agent directory of its own - it does not share one with
      // the other items (examples/coding-harness/kit.test.ts installs and runs it).
      if (entry.type === 'kit') continue;
      const result = await add([entry.name, '--registry', INDEX, '--dir', 'agent', '--yes', '--allow', 'network,env']);
      expect(result.err, entry.name).toBe('');
      expect(result.code, entry.name).toBe(0);
    }
    expect(fs.existsSync(path.join(agentDir, 'tools', 'open-meteo-weather.ts'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'tools', 'github-issues.ts'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'changelog', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'code-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'channels', 'generic-webhook.ts'))).toBe(true);

    // The channel reads its secret at load; it is set here only for the load.
    const secret = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = 'lousho-default-registry-test';
    try {
      const { manifest, channels } = await resolveAgentDir(agentDir);
      expect(manifest.tools.slice().sort()).toEqual(['github-issues-create', 'github-issues-list', 'open-meteo-weather']);
      expect(manifest.skills.slice().sort()).toEqual(['changelog', 'code-review']);
      expect(manifest.channels).toEqual(['generic-webhook']);
      expect(typeof channels[0].verify).toBe('function');
    } finally {
      if (secret === undefined) delete process.env.WEBHOOK_SECRET;
      else process.env.WEBHOOK_SECRET = secret;
    }
  });
});
