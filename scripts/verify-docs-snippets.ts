/**
 * verify-docs-snippets (LOU-I7)
 *
 * Extracts every ```ts / ```typescript fenced code block from the Quick
 * Start docs (or the markdown files passed as arguments) and proves each
 * one type-checks AND runs without error against the LOCALLY BUILT package
 * - exactly what a reader copy-pasting it into a fresh project would get.
 *
 * How (mirrors LOU-H4's create-loushy-agent approach for its generated
 * projects): build the SDK, `npm pack` it, install the tarball into a
 * throwaway temp project, write each snippet there as its own ES module
 * (`snippet-<n>.mts`), then
 *   1. `tsc --noEmit` (strict, module nodenext) over all snippets, and
 *   2. run each snippet with tsx, failing on a non-zero exit.
 *
 * Usage:
 *   npx tsx scripts/verify-docs-snippets.ts [docs/quick-start.md ...] [--skip-build] [--keep]
 *
 *   --skip-build  reuse the current dist/ instead of running `npm run build`
 *   --keep        keep the temp project (its path is printed) for debugging
 *
 * Snippets run with provider credential env vars (OPENAI_API_KEY, ...)
 * removed, so they exercise the mock-provider path deterministically and
 * never make network calls. A fence whose info string contains
 * `no-verify` (e.g. ```ts no-verify) is skipped.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DOCS = [path.join(REPO_ROOT, 'docs', 'quick-start.md')];
const CREDENTIAL_ENV_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];
const SNIPPET_TIMEOUT_MS = 60_000;

export interface Snippet {
  file: string;
  /** 1-based line number of the opening fence. */
  line: number;
  source: string;
}

export function extractSnippets(markdown: string, file: string): Snippet[] {
  const snippets: Snippet[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^```(ts|typescript)\b(.*)$/);
    if (!open) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    if (!open[2].includes('no-verify')) {
      snippets.push({ file, line: start + 1, source: body.join('\n') + '\n' });
    }
  }
  return snippets;
}

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function run(cmd: string, args: string[], cwd: string): string {
  // shell:true is needed on Windows to run npm.cmd; every argument here is a
  // fixed literal or a path this script computed itself (same reasoning as
  // packages/create-loushy-agent/src/template.ts).
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function setUpProject(projectDir: string, skipBuild: boolean): void {
  if (!skipBuild) {
    console.log('- building the SDK (npm run build)...');
    run(npmCmd, ['run', 'build'], REPO_ROOT);
  }

  console.log('- packing the SDK (npm pack)...');
  const packOutput = run(npmCmd, ['pack', '--pack-destination', projectDir], REPO_ROOT);
  const tarball = packOutput.trim().split(/\r?\n/).pop()!.trim();

  const rootPkg = readJson(path.join(REPO_ROOT, 'package.json'));
  const peers: Record<string, string> = rootPkg.peerDependencies;
  const dev: Record<string, string> = rootPkg.devDependencies;

  // Everything a reader installs per docs/installation.md: the SDK, its
  // required peers (ai, zod) and - because the root entry currently loads
  // every provider module - the optional provider packages too.
  const dependencies: Record<string, string> = {
    '@loushy/build-ai-agent': `file:./${tarball}`,
    ai: peers.ai,
    zod: peers.zod,
    '@ai-sdk/openai': peers['@ai-sdk/openai'],
    '@ai-sdk/anthropic': peers['@ai-sdk/anthropic'],
    'ollama-ai-provider': peers['ollama-ai-provider'],
  };
  const devDependencies: Record<string, string> = {
    typescript: dev.typescript,
    tsx: dev.tsx,
    '@types/node': dev['@types/node'],
  };

  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'docs-snippets', private: true, type: 'module', dependencies, devDependencies }, null, 2)
  );
  fs.writeFileSync(
    path.join(projectDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['snippet-*.mts'],
      },
      null,
      2
    )
  );

  console.log('- installing the packed SDK into a temp project (npm install)...');
  run(npmCmd, ['install', '--no-audit', '--no-fund'], projectDir);
}

interface Failure {
  snippet: Snippet;
  stage: 'typecheck' | 'run';
  output: string;
}

function main(): void {
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--skip-build');
  const keep = args.includes('--keep');
  const docs = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));

  const snippets = (docs.length > 0 ? docs : DEFAULT_DOCS).flatMap((file) =>
    extractSnippets(fs.readFileSync(file, 'utf8'), path.relative(REPO_ROOT, file))
  );
  if (snippets.length === 0) {
    console.error('verify-docs-snippets: no ```ts snippets found');
    process.exit(1);
  }
  console.log(`verify-docs-snippets: ${snippets.length} snippet(s) found`);

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-docs-snippets-'));
  const failures: Failure[] = [];
  try {
    setUpProject(projectDir, skipBuild);

    const files = snippets.map((snippet, index) => {
      const name = `snippet-${index + 1}.mts`;
      fs.writeFileSync(
        path.join(projectDir, name),
        `// ${snippet.file}:${snippet.line}\n${snippet.source}\nexport {};\n`
      );
      return name;
    });

    console.log('- type-checking all snippets (tsc --noEmit)...');
    const tsc = spawnSync(process.execPath, [path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    const tscOutput = `${tsc.stdout}${tsc.stderr}`;
    files.forEach((name, index) => {
      const errors = tscOutput.split(/\r?\n/).filter((l) => l.startsWith(name));
      if (errors.length > 0) failures.push({ snippet: snippets[index], stage: 'typecheck', output: errors.join('\n') });
    });
    if (tsc.status !== 0 && failures.length === 0) {
      throw new Error(`tsc failed without per-snippet errors:\n${tscOutput}`);
    }

    const env = { ...process.env };
    for (const key of CREDENTIAL_ENV_VARS) delete env[key];
    const tsxCli = path.join(projectDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

    files.forEach((name, index) => {
      const snippet = snippets[index];
      const result = spawnSync(process.execPath, [tsxCli, name], {
        cwd: projectDir,
        env,
        encoding: 'utf8',
        timeout: SNIPPET_TIMEOUT_MS,
      });
      const output = `${result.stdout}${result.stderr}`.trim();
      const ok = result.status === 0 && !result.error;
      const typeOk = !failures.some((f) => f.snippet === snippet && f.stage === 'typecheck');
      const status = ok && typeOk ? 'PASS' : `FAIL (${[typeOk ? '' : 'typecheck', ok ? '' : 'run'].filter(Boolean).join(' + ')})`;
      console.log(`  ${status} ${snippet.file}:${snippet.line} (${name})`);
      if (output) console.log(output.replace(/^/gm, '      | '));
      if (!ok) {
        failures.push({ snippet, stage: 'run', output: result.error ? String(result.error) : output });
      }
    });
  } finally {
    if (keep) console.log(`- temp project kept at ${projectDir}`);
    else fs.rmSync(projectDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\nverify-docs-snippets: ${failures.length} failure(s)`);
    for (const f of failures) {
      console.error(`\n[${f.stage}] ${f.snippet.file}:${f.snippet.line}\n${f.output}`);
    }
    process.exit(1);
  }
  console.log(`\nverify-docs-snippets: all ${snippets.length} snippet(s) type-check and run cleanly`);
}

if (require.main === module) {
  main();
}
