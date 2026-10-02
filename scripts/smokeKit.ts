// fallow-ignore-file complexity
/**
 * Helpers shared by `pack-smoke` (the tarball built from the checkout) and
 * `registry-smoke` (the packages as published on npm). Kept in one place so the
 * two scripts cannot drift and `fallow` sees no duplicated code.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SDK_NAME = '@lousho/build-ai-agent';
export const IS_WIN = process.platform === 'win32';

/** Optional peers: a subpath whose load fails because one of these is absent is checked by file existence only. */
const OPTIONAL_PEERS = ['vue', 'react', 'svelte', '@opentelemetry/api', '@modelcontextprotocol/sdk', 'dockerode', 'prompts', 'tsup', 'better-sqlite3'];

/** Collects failures and prints `[<prefix>]` lines. */
export interface Reporter {
  failures: string[];
  log(msg: string): void;
  fail(msg: string): void;
}

export function createReporter(prefix: string): Reporter {
  const failures: string[] = [];
  return {
    failures,
    log: (msg) => console.log(`[${prefix}] ${msg}`),
    fail: (msg) => {
      failures.push(msg);
      console.error(`[${prefix}] FAIL: ${msg}`);
    },
  };
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a command; `npm`/`npx` go through the shell on Windows (they are .cmd shims). */
export function run(cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): RunResult {
  const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const useShell = IS_WIN && (cmd === 'npm' || cmd === 'npx');
  const res = useShell
    ? spawnSync([cmd, ...argv.map(quote)].join(' '), { cwd, env, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 })
    : spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function mustRun(rep: Reporter, label: string, cmd: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  rep.log(label);
  const res = run(cmd, argv, cwd, env);
  if (res.status !== 0) {
    console.error(res.stdout + res.stderr);
    throw new Error(`${label} failed (exit ${res.status})`);
  }
  return res;
}

/** All `exports` subpaths with their targets, from the installed package.json. */
function listExports(pkgDir: string): { subpath: string; spec: string; targets: string[] }[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  return Object.entries<Record<string, string>>(pkg.exports).map(([subpath, conds]) => ({
    subpath,
    spec: subpath === '.' ? SDK_NAME : `${SDK_NAME}/${subpath.slice(2)}`,
    targets: Object.values(conds),
  }));
}

/** Source of a probe script that loads every spec in one module format and prints JSON results. */
function probeSource(format: 'esm' | 'cjs', specs: string[]): string {
  const load = format === 'esm' ? 'await import(spec)' : 'require(spec)';
  const body = `
const specs = ${JSON.stringify(specs)};
const optional = ${JSON.stringify(OPTIONAL_PEERS)};
const results = [];
for (const spec of specs) {
  try { ${load}; results.push({ spec, ok: true }); }
  catch (e) {
    const msg = String(e && e.message);
    const missingCode = e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND');
    const peer = missingCode && optional.find((p) => msg.includes("'" + p + "'") || msg.includes('"' + p + '"') || msg.includes('/' + p + '/'));
    results.push({ spec, ok: false, peer: peer || null, error: msg.split('\\n')[0] });
  }
}
console.log('RESULTS ' + JSON.stringify(results));
`;
  return format === 'esm' ? body : `(async () => {${body}})().catch((e) => { console.error(e); process.exit(1); });`;
}

function turnSource(format: 'esm' | 'cjs'): string {
  const body = `
const agent = createAgent({ provider: mockModel(['hello from the mock']), prompt: 'You are a test.' });
const result = await agent.send('hi');
if (result.text !== 'hello from the mock') throw new Error('unexpected reply: ' + result.text);
console.log('TURN_OK');
`;
  if (format === 'esm') {
    return `import { createAgent } from '${SDK_NAME}';\nimport { mockModel } from '${SDK_NAME}/testing';\n${body}`;
  }
  return `const { createAgent } = require('${SDK_NAME}');\nconst { mockModel } = require('${SDK_NAME}/testing');\n(async () => {${body}})().catch((e) => { console.error(e); process.exit(1); });\n`;
}

export function checkModuleLoads(rep: Reporter, project: string, pkgDir: string): void {
  const exportsList = listExports(pkgDir);
  for (const e of exportsList) {
    for (const t of e.targets) {
      if (!fs.existsSync(path.join(pkgDir, t))) rep.fail(`export ${e.subpath}: target ${t} does not exist in the installed package`);
    }
  }
  const specs = exportsList.map((e) => e.spec);
  for (const format of ['esm', 'cjs'] as const) {
    const file = path.join(project, `probe.${format === 'esm' ? 'mjs' : 'cjs'}`);
    fs.writeFileSync(file, probeSource(format, specs));
    const res = run(process.execPath, [file], project);
    const line = res.stdout.split('\n').find((l) => l.startsWith('RESULTS '));
    if (res.status !== 0 || !line) {
      rep.fail(`${format} probe crashed: ${res.stderr || res.stdout}`);
      continue;
    }
    const results = JSON.parse(line.slice(8)) as { spec: string; ok: boolean; peer: string | null; error?: string }[];
    for (const r of results) {
      if (r.ok) continue;
      if (r.peer) rep.log(`${format} ${r.spec}: optional peer ${r.peer} not installed, checked by file existence only`);
      else rep.fail(`${format} ${r.spec} failed to load: ${r.error}`);
    }
    rep.log(`${format}: ${results.filter((r) => r.ok).length}/${results.length} entries loaded`);

    const turn = path.join(project, `turn.${format === 'esm' ? 'mjs' : 'cjs'}`);
    fs.writeFileSync(turn, turnSource(format));
    const t = run(process.execPath, [turn], project);
    if (!t.stdout.includes('TURN_OK')) rep.fail(`${format} mock agent turn failed: ${t.stderr || t.stdout}`);
    else rep.log(`${format}: createAgent + mockModel turn ok`);
  }
}

export function checkBin(rep: Reporter, project: string): void {
  const installed = path.join(project, 'node_modules', '.bin', IS_WIN ? 'lousho.cmd' : 'lousho');
  if (!fs.existsSync(installed)) return rep.fail(`node_modules/.bin/lousho was not created (${installed})`);
  const help = run('npx', ['--no-install', 'lousho', '--help'], project);
  if (help.status !== 0 || !/lousho init/.test(help.stdout + help.stderr)) rep.fail(`npx lousho --help failed: ${help.stdout}${help.stderr}`);
  else rep.log('npx lousho --help: ok');
  const clean = { ...process.env };
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete clean[k];
  const doctor = run('npx', ['--no-install', 'lousho', 'doctor', '--json'], project, clean);
  // doctor exits non-zero when a check fails (e.g. no API key); only a crash is a smoke failure.
  try {
    const parsed = JSON.parse(doctor.stdout);
    rep.log(`lousho doctor: ran (exit ${doctor.status}, ${JSON.stringify(parsed).length} bytes of JSON)`);
  } catch {
    rep.fail(`lousho doctor did not produce JSON: ${doctor.stdout}${doctor.stderr}`);
  }
}
