/**
 * verify-docs-snippets (LOU-I7)
 *
 * Extracts every ```ts / ```typescript fenced code block from the Quick
 * Start docs (or the markdown files passed as arguments) and proves each
 * one type-checks AND runs without error against the LOCALLY BUILT package
 * - exactly what a reader copy-pasting it into a fresh project would get.
 *
 * How (mirrors LOU-H4's create-lousho-agent approach for its generated
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
 * Two stages (LOU-U5):
 *
 *   A. SOURCE CHECK - every ```ts / ```typescript block in README.md and
 *      docs/*.md (all of them, not just the quick start) is type-checked
 *      against the real SDK SOURCE: `@lousho/build-ai-agent` and its subpaths
 *      are resolved to `src/` through `paths` derived from package.json
 *      `exports`, so a docs example can never drift from the code (wrong
 *      argument order, methods that do not exist, ...). Types only; nothing
 *      is executed.
 *   B. PACKED RUN - the quick-start docs (the "paste it and it works" path)
 *      are additionally type-checked AND run against the packed tarball, as
 *      described above.
 *
 * Intentionally partial snippets (they use `agent`, `provider`, `storage`...
 * without defining them) do NOT need an opt-out: stage A prepends an
 * ambient preamble (PLACEHOLDERS below) that declares those
 * common names as typed globals. A snippet's own `const agent = ...`
 * shadows the placeholder, so only genuinely free names are covered. To add
 * a placeholder, add an entry to PLACEHOLDERS. For a block that
 * cannot be checked at all, put `no-verify` in its fence info
 * (```ts no-verify) - it is skipped by both stages.
 *
 * Snippets run with provider credential env vars (OPENAI_API_KEY, ...)
 * removed, so they exercise the mock-provider path deterministically and
 * never make network calls. A fence whose info string contains
 * `no-verify` (e.g. ```ts no-verify) is skipped. One containing `no-run`
 * (e.g. ```ts no-run) is still type-checked by both stages but not executed,
 * for snippets that need a real API key to run (LOU-D1).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
/** Docs that are type-checked AND executed against the packed tarball (stage B). */
const RUNNABLE_DOCS = [path.join(REPO_ROOT, 'docs', 'quick-start.md')];
/** Ambient names (typed against the SDK where possible) that intentionally-partial snippets may use without defining. */
const SDK = "import('@lousho/build-ai-agent')";
const PLACEHOLDERS: Record<string, string> = {
  agent: `${SDK}.AgentConfig`,
  provider: `${SDK}.LLMProvider`,
  registry: `import('@lousho/build-ai-agent/executor').ToolRegistry`,
  toolRegistry: `import('@lousho/build-ai-agent/executor').ToolRegistry`,
  storage: `import('@lousho/build-ai-agent/utils').StorageService`,
  approvalStore: `${SDK}.ApprovalStore`,
  checkpointStore: `${SDK}.CheckpointStore`,
  mcpClient: "import('@modelcontextprotocol/sdk/client/index.js').Client",
  input: 'string',
  patch: 'string',
  repoPath: 'string',
  file: 'File',
  emailTool: 'any',
};
const PLACEHOLDER_DECLARATIONS = Object.entries(PLACEHOLDERS)
  .map(([name, type]) => `declare var ${name}: ${type};`)
  .join('\n');
const CREDENTIAL_ENV_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];
const SNIPPET_TIMEOUT_MS = 60_000;

export interface Snippet {
  file: string;
  /** 1-based line number of the opening fence. */
  line: number;
  source: string;
  /** The fence says `no-run`: type-check only, never execute. */
  noRun: boolean;
}

/** Index of the closing fence at or after `from`, or lines.length when the block is unterminated. */
function findFenceEnd(lines: string[], from: number): number {
  let end = from;
  while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
  return end;
}

export function extractSnippets(markdown: string, file: string): Snippet[] {
  const snippets: Snippet[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^```(ts|typescript)\b(.*)$/);
    if (!open) continue;
    const end = findFenceEnd(lines, i + 1);
    if (!open[2].includes('no-verify')) {
      const source = lines.slice(i + 1, end).join('\n') + '\n';
      snippets.push({ file, line: i + 1, source, noRun: open[2].includes('no-run') });
    }
    i = end;
  }
  return snippets;
}

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function run(cmd: string, args: string[], cwd: string): string {
  // shell:true is needed on Windows to run npm.cmd; every argument here is a
  // fixed literal or a path this script computed itself (same reasoning as
  // packages/create-lousho-agent/src/template.ts).
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
  // every provider module - the optional provider packages too. `ai` and
  // `@ai-sdk/*` peer on several majors (LOU-D28d): pin the pairing the repo
  // develops against (its devDependencies), not whatever the widest range resolves to.
  const dependencies: Record<string, string> = {
    '@lousho/build-ai-agent': `file:./${tarball}`,
    ai: dev.ai,
    zod: peers.zod,
    '@ai-sdk/openai': dev['@ai-sdk/openai'],
    '@ai-sdk/anthropic': dev['@ai-sdk/anthropic'],
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

/** Writes each snippet into the temp project as its own `snippet-<n>.mts`; returns the file names. */
function writeSnippetFiles(projectDir: string, snippets: Snippet[]): string[] {
  return snippets.map((snippet, index) => {
    const name = `snippet-${index + 1}.mts`;
    fs.writeFileSync(
      path.join(projectDir, name),
      `// ${snippet.file}:${snippet.line}\n${snippet.source}\nexport {};\n`
    );
    return name;
  });
}

/** Runs tsc over all snippets and returns one 'typecheck' failure per snippet with errors. */
function typeCheckSnippets(projectDir: string, files: string[], snippets: Snippet[]): Failure[] {
  console.log('- type-checking all snippets (tsc --noEmit)...');
  const tsc = spawnSync(process.execPath, [path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  const tscOutput = `${tsc.stdout}${tsc.stderr}`;
  const failures: Failure[] = [];
  files.forEach((name, index) => {
    const errors = tscOutput.split(/\r?\n/).filter((l) => l.startsWith(name));
    if (errors.length > 0) failures.push({ snippet: snippets[index], stage: 'typecheck', output: errors.join('\n') });
  });
  if (tsc.status !== 0 && failures.length === 0) {
    throw new Error(`tsc failed without per-snippet errors:\n${tscOutput}`);
  }
  return failures;
}

/** Runs one snippet with tsx and reports whether it exited cleanly, plus its combined output. */
function executeSnippet(
  projectDir: string,
  env: NodeJS.ProcessEnv,
  name: string
): { ok: boolean; output: string; error?: Error } {
  const tsxCli = path.join(projectDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(process.execPath, [tsxCli, name], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    timeout: SNIPPET_TIMEOUT_MS,
  });
  return {
    ok: result.status === 0 && !result.error,
    output: `${result.stdout}${result.stderr}`.trim(),
    error: result.error,
  };
}

function snippetStatusLabel(ok: boolean, typeOk: boolean): string {
  const failedStages = [!typeOk && 'typecheck', !ok && 'run'].filter(Boolean);
  return failedStages.length === 0 ? 'PASS' : `FAIL (${failedStages.join(' + ')})`;
}

/** Runs one snippet, prints its PASS/FAIL line, and returns its 'run' failure (if any). */
function runSnippet(
  projectDir: string,
  env: NodeJS.ProcessEnv,
  name: string,
  snippet: Snippet,
  typeOk: boolean
): Failure | undefined {
  const { ok, output, error } = executeSnippet(projectDir, env, name);
  console.log(`  ${snippetStatusLabel(ok, typeOk)} ${snippet.file}:${snippet.line} (${name})`);
  if (output) console.log(output.replace(/^/gm, '      | '));
  if (ok) return undefined;
  return { snippet, stage: 'run', output: error ? String(error) : output };
}

/** Runs every snippet with provider credentials stripped from the environment. */
function runSnippets(projectDir: string, files: string[], snippets: Snippet[], typeFailures: Failure[]): Failure[] {
  const env = { ...process.env };
  for (const key of CREDENTIAL_ENV_VARS) delete env[key];

  const failures: Failure[] = [];
  files.forEach((name, index) => {
    const snippet = snippets[index];
    if (snippet.noRun) {
      console.log(`  SKIP (no-run) ${snippet.file}:${snippet.line} (${name})`);
      return;
    }
    const typeOk = !typeFailures.some((f) => f.snippet === snippet);
    const failure = runSnippet(projectDir, env, name, snippet, typeOk);
    if (failure) failures.push(failure);
  });
  return failures;
}

function loadSnippets(docs: string[]): Snippet[] {
  return docs.flatMap((file) => extractSnippets(fs.readFileSync(file, 'utf8'), path.relative(REPO_ROOT, file)));
}

/** README.md plus every docs/*.md page (the default stage A input). */
function allDocFiles(): string[] {
  const docsDir = path.join(REPO_ROOT, 'docs');
  const pages = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();
  return [path.join(REPO_ROOT, 'README.md'), ...pages.map((f) => path.join(docsDir, f))];
}

/** tsconfig `paths` mapping each package.json export's types entry (dist/*.d.ts) to its src/*.ts source. */
function sourcePaths(): Record<string, string[]> {
  const pkg = readJson(path.join(REPO_ROOT, 'package.json'));
  const paths: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries<{ types: string }>(pkg.exports)) {
    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
    paths[specifier] = [target.types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts')];
  }
  return paths;
}

/** Writes the stage A tsconfig + placeholder preamble and one `snippet-<n>.ts` per snippet; returns the file names. */
function writeSourceProject(dir: string, snippets: Snippet[]): string[] {
  fs.writeFileSync(path.join(dir, 'placeholders.d.ts'), `${PLACEHOLDER_DECLARATIONS}\n`);
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: '../tsconfig.json',
      compilerOptions: {
        rootDir: '..',
        baseUrl: '..',
        paths: sourcePaths(),
        noEmit: true,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
      include: ['./*.ts', '../typings/**/*.d.ts'],
      exclude: [],
    })
  );
  return snippets.map((snippet, index) => {
    const name = `snippet-${index + 1}.ts`;
    fs.writeFileSync(path.join(dir, name), `// ${snippet.file}:${snippet.line}\n${snippet.source}\nexport {};\n`);
    return name;
  });
}

/** Maps tsc output lines (`<dir>/snippet-N.ts(...)`) back to the snippet that produced them. */
function collectTypeFailures(output: string, dir: string, files: string[], snippets: Snippet[], ok: boolean): Failure[] {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/\\/g, '/'));
  const prefix = path.relative(REPO_ROOT, dir).replace(/\\/g, '/');
  const failures: Failure[] = [];
  files.forEach((name, index) => {
    const errors = lines.filter((l) => l.startsWith(`${prefix}/${name}(`));
    if (errors.length > 0) failures.push({ snippet: snippets[index], stage: 'typecheck', output: errors.join('\n') });
  });
  if (!ok && failures.length === 0) throw new Error(`tsc failed without per-snippet errors:\n${output}`);
  return failures;
}

/**
 * Stage A: type-checks every snippet against src/ (not the built package).
 * The temp project lives inside the repo so `ai`, `zod`, ... resolve from the
 * repo's node_modules; it is always removed afterwards.
 */
function checkAgainstSource(snippets: Snippet[]): Failure[] {
  console.log(`- type-checking ${snippets.length} snippet(s) against src/ (tsc --noEmit)...`);
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, '.docs-snippets-'));
  try {
    const files = writeSourceProject(dir, snippets);
    const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = spawnSync(process.execPath, [tsc, '-p', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
    return collectTypeFailures(`${result.stdout}${result.stderr}`, dir, files, snippets, result.status === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Stage B: type-check and run the snippets against the packed tarball in a throwaway project. */
function verifyPacked(snippets: Snippet[], skipBuild: boolean, keep: boolean): Failure[] {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docs-snippets-'));
  try {
    setUpProject(projectDir, skipBuild);
    const files = writeSnippetFiles(projectDir, snippets);
    const typeFailures = typeCheckSnippets(projectDir, files, snippets);
    return [...typeFailures, ...runSnippets(projectDir, files, snippets, typeFailures)];
  } finally {
    if (keep) console.log(`- temp project kept at ${projectDir}`);
    else fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

function reportFailures(failures: Failure[]): void {
  console.error(`\nverify-docs-snippets: ${failures.length} failure(s)`);
  for (const f of failures) {
    console.error(`\n[${f.stage}] ${f.snippet.file}:${f.snippet.line}\n${f.output}`);
  }
}

function orDefault(explicit: string[], fallback: () => string[]): string[] {
  return explicit.length > 0 ? explicit : fallback();
}

/** Loads the stage A (all docs) and stage B (runnable docs) snippet sets, honouring explicit file arguments. */
function loadSnippetSets(docs: string[]): { sourceSnippets: Snippet[]; runnableSnippets: Snippet[] } {
  const sourceSnippets = loadSnippets(orDefault(docs, allDocFiles));
  const runnableSnippets = loadSnippets(orDefault(docs, () => RUNNABLE_DOCS));
  if (Math.min(sourceSnippets.length, runnableSnippets.length) === 0) {
    console.error('verify-docs-snippets: no ```ts snippets found');
    process.exit(1);
  }
  return { sourceSnippets, runnableSnippets };
}

function main(): void {
  const args = process.argv.slice(2);
  const docs = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
  const { sourceSnippets, runnableSnippets } = loadSnippetSets(docs);
  console.log(`verify-docs-snippets: ${sourceSnippets.length} snippet(s) found (${runnableSnippets.length} runnable)`);

  const packed = verifyPacked(runnableSnippets, args.includes('--skip-build'), args.includes('--keep'));
  const failures = [...checkAgainstSource(sourceSnippets), ...packed];
  if (failures.length > 0) {
    reportFailures(failures);
    process.exit(1);
  }
  console.log(
    `
verify-docs-snippets: all ${sourceSnippets.length} snippet(s) type-check against src/; ${runnableSnippets.length} also run cleanly`
  );
}

if (require.main === module) {
  main();
}
