/**
 * size-check (C10)
 *
 * Two size budgets, both committed in scripts/size-budget.json so growth shows
 * up as a reviewed diff instead of a surprise:
 *
 *   1. bundleBytes: a hello-world app (`import { createAgent } from '<built
 *      root>'` + `agent.send()`) bundled with esbuild, minified, platform node,
 *      with every bare package specifier (the peers) left external. This is the
 *      cost of the SDK in a user's bundle; a new eager import in the root entry
 *      shows up here.
 *   2. tarballUnpackedBytes: the unpacked size `npm pack` reports for the
 *      published package (what lands in node_modules).
 *
 * Needs a built `dist/` (`npm run build`). `npm pack` runs with --dry-run and
 * --ignore-scripts, so nothing is written; the tarball figure includes the
 * Agent Forge build only when `npm run build:studio` ran first (CI does both,
 * so its figure is the real one).
 *
 * Usage: npm run size-check [-- --update]
 *   --update  rewrites the budgets to the current measurement + 5%.
 */
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter, run } from './smokeKit';

const ROOT = path.resolve(__dirname, '..');
const BUDGET_FILE = path.join(__dirname, 'size-budget.json');
const HEADROOM = 1.05;

interface Budget {
  bundleBytes: number;
  tarballUnpackedBytes: number;
}

const HELLO_WORLD = `
import { createAgent } from './dist/index.mjs';
const agent = createAgent({ model: 'openai/gpt-4o-mini', prompt: 'Be brief.' });
const { text } = await agent.send('Hello!');
console.log(text);
`;

async function measureBundle(): Promise<number> {
  const result = await build({
    stdin: { contents: HELLO_WORLD, resolveDir: ROOT, sourcefile: 'hello.mjs', loader: 'js' },
    bundle: true,
    minify: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  });
  return result.outputFiles.reduce((sum, file) => sum + file.contents.byteLength, 0);
}

function measureTarball(): number {
  const res = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], ROOT);
  if (res.status !== 0) throw new Error(`npm pack --dry-run failed:\n${res.stderr}`);
  return (JSON.parse(res.stdout) as { unpackedSize: number }[])[0].unpackedSize;
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MB`;

const CHECKS = [
  ['bundleBytes', 'hello-world bundle'],
  ['tarballUnpackedBytes', 'tarball unpacked size'],
] as const;

async function main(): Promise<void> {
  const rep = createReporter('size-check');
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.mjs'))) {
    rep.fail('dist/index.mjs is missing: run `npm run build` first');
    process.exit(1);
  }
  const measured: Budget = { bundleBytes: await measureBundle(), tarballUnpackedBytes: measureTarball() };

  if (process.argv.includes('--update')) {
    const next: Budget = {
      bundleBytes: Math.ceil(measured.bundleBytes * HEADROOM),
      tarballUnpackedBytes: Math.ceil(measured.tarballUnpackedBytes * HEADROOM),
    };
    fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
    rep.log(`budgets updated: bundle ${mb(next.bundleBytes)}, tarball unpacked ${mb(next.tarballUnpackedBytes)}`);
    return;
  }

  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Budget;
  for (const [key, label] of CHECKS) {
    rep.log(`${label}: ${mb(measured[key])} (budget ${mb(budget[key])})`);
    if (measured[key] > budget[key]) {
      rep.fail(`${label} is ${measured[key]} bytes, over the ${budget[key]} budget. Cut the growth, or raise scripts/size-budget.json in the same PR (npm run size-check -- --update) and say why.`);
    }
  }
  if (rep.failures.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
