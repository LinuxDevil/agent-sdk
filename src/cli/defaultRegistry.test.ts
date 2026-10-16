/**
 * The committed default registry: `registry/dist/index.json` plus one
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
 * run, as in CI. The temp agent directory (in the OS temp dir) gets a
 * `node_modules` link to the repository's, so its `zod` and
 * `@lousho/build-ai-agent` imports resolve like a real project's (the
 * package's workspace self-link, node_modules for zod).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  // The node_modules link lets the installed files' `zod` and
  // `@lousho/build-ai-agent` imports resolve (see the comment at the top).
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-default-registry-'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
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
      'coding-pi',
      'generic-webhook',
      'github-issues',
      'inbox-triage',
      'incident-response',
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

  // The CLI loads agent directories with Node's own type stripping, which needs the
  // `.ts` extension on relative imports; vitest and tsup resolve `./lib/x` anyway, so
  // only a plain `node` process catches a kit that `lousho dev`/`chat` cannot load.
  it('installs every kit and each loads under plain node, as the CLI loads it', async () => {
    const index = IndexSchema.parse(JSON.parse(fs.readFileSync(INDEX, 'utf8')));
    const kits = index.items.filter((entry) => entry.type === 'kit');
    expect(kits.length).toBeGreaterThan(0);
    const loader =
      "const { resolveAgentDir } = await import('@lousho/build-ai-agent');" +
      'const { manifest } = await resolveAgentDir(process.argv[1]);' +
      'console.log(JSON.stringify({ tools: manifest.tools.length }));';
    // Dummy keys and secrets: the kits are only loaded, never run.
    const env = { ...process.env, NODE_OPTIONS: '', OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', WEBHOOK_SECRET: 'x', INBOUND_TOKEN: 'x' };
    for (const entry of kits) {
      const result = await add([entry.name, '--registry', INDEX, '--dir', entry.name, '--yes', '--allow', 'exec,fs-write,network,env']);
      expect(result.err, entry.name).toBe('');
      expect(result.code, entry.name).toBe(0);
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', loader, path.join(root, entry.name)], {
        cwd: root,
        encoding: 'utf8',
        env: { ...env, INBOX_TRIAGE_HOME: path.join(root, `${entry.name}-home`) },
      });
      expect(run.status, `${entry.name}: ${run.stderr}`).toBe(0);
      expect(JSON.parse(run.stdout.trim().split('\n').pop() as string).tools, entry.name).toBeGreaterThan(0);
    }
  }, 120_000);
});
