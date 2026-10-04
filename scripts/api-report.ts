/**
 * api-report (A7, #245): one checked-in API report per `package.json` `exports`
 * entry, generated with @microsoft/api-extractor run programmatically on the
 * entry's `types` file (dist/*.d.ts). The report freezes the public surface
 * for 1.0: `npm run api:update` rewrites api/<name>.api.md, `npm run api:check`
 * fails (with the diff) when a report would differ, so a public-API change is
 * always a deliberate, reviewed diff.
 *
 * Reports are named after the subpath, not the dist file: `index.api.md` for
 * `.`, `executor.api.md` for `./executor`, `mcp.api.md` for `./mcp`, and so on.
 *
 * tsup emits chunked declarations (dist/index.d.ts imports hashed
 * dist/<name>-<hash>.d.ts chunks through `.js` specifiers), which only resolve
 * under a bundler/node16-style resolution: every entry therefore gets
 * `compiler.overrideTsconfig` with `moduleResolution: "bundler"`.
 *
 * `ae-missing-release-tag` is suppressed (the codebase does not use release
 * tags); `ae-forgotten-export` goes into the report so unexported types that
 * public signatures use stay visible. Reports must be stable across machines:
 * `newlineKind: 'lf'` and no absolute paths; `api/**` is eol=lf via
 * .gitattributes.
 *
 * Needs `npm run build` first (the reports are generated from dist/).
 *
 * Usage:
 *   tsx scripts/api-report.ts           # write/update api/*.api.md
 *   tsx scripts/api-report.ts --check   # fail if any report differs
 */
import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor';
import type { ExtractorMessage, IConfigFile } from '@microsoft/api-extractor';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(REPO_ROOT, 'api');

interface EntryPoint {
  /** Subpath as declared in `exports` ('.', './executor', ...). */
  subpath: string;
  /** Report base name: 'index' for '.', 'executor' for './executor'. */
  name: string;
  /** Absolute path of the entry's `types` file. */
  typesPath: string;
}

function entryPoints(): EntryPoint[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return Object.entries<{ types?: string }>(pkg.exports).map(([subpath, target]) => {
    if (!target.types) throw new Error(`exports entry "${subpath}" has no "types"`);
    return {
      subpath,
      name: subpath === '.' ? 'index' : subpath.replace(/^\.\//, ''),
      typesPath: path.resolve(REPO_ROOT, target.types),
    };
  });
}

function configObjectFor(entry: EntryPoint, tempDir: string): IConfigFile {
  return {
    projectFolder: REPO_ROOT,
    mainEntryPointFilePath: entry.typesPath,
    compiler: {
      overrideTsconfig: {
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'es2022',
          lib: ['es2022', 'dom'],
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          types: ['node'],
        },
        files: [entry.typesPath],
      },
    },
    apiReport: {
      enabled: true,
      reportFileName: `${entry.name}.api.md`,
      reportFolder: API_DIR,
      reportTempFolder: tempDir,
      includeForgottenExports: true,
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    newlineKind: 'lf',
    messages: {
      extractorMessageReporting: {
        'ae-missing-release-tag': { logLevel: ExtractorLogLevel.None },
        'ae-forgotten-export': { logLevel: ExtractorLogLevel.Warning, addToApiReportFile: true },
      },
    },
  };
}

/**
 * Prints the unified diff between the checked-in report and the freshly
 * generated one in `tempDir` (what `api:check` shows when a report is stale).
 */
function showReportDiff(entry: EntryPoint, tempDir: string): void {
  const committed = path.join(API_DIR, `${entry.name}.api.md`);
  const generated = path.join(tempDir, `${entry.name}.api.md`);
  if (!fs.existsSync(generated)) return;
  // `git diff --no-index` exits 1 on differences; its stdout is the diff.
  const diff = spawnSync('git', ['diff', '--no-index', '--', committed, generated], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (diff.stdout) {
    // Re-label the paths so the diff reads `a/api/<name>.api.md` (committed)
    // vs `b/api/<name>.api.md` (generated), not the absolute temp path.
    const label = `api/${entry.name}.api.md`;
    const clean = diff.stdout
      .split('\n')
      .map((line) => {
        if (line.startsWith('diff --git ')) return `diff --git a/${label} b/${label}`;
        if (line.startsWith('--- ')) return `--- a/${label}`;
        if (line.startsWith('+++ ')) return `+++ b/${label}`;
        return line;
      })
      .join('\n');
    console.log(clean.trimEnd());
    return;
  }
  // Fallback without git: the first lines that differ.
  const a = fs.existsSync(committed) ? fs.readFileSync(committed, 'utf8').split('\n') : [];
  const b = fs.readFileSync(generated, 'utf8').split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) console.log(`- ${a[i]}`);
    if (b[i] !== undefined) console.log(`+ ${b[i]}`);
    if (i > 60) break;
  }
}

interface EntryResult {
  entry: EntryPoint;
  errorCount: number;
  warningCount: number;
  apiReportChanged: boolean;
  errors: string[];
}

function runEntry(entry: EntryPoint, check: boolean, tempDir: string): EntryResult {
  const config = ExtractorConfig.prepare({
    configObject: configObjectFor(entry, tempDir),
    configObjectFullPath: undefined,
    packageJsonFullPath: path.join(REPO_ROOT, 'package.json'),
  });

  const errors: string[] = [];
  const result = Extractor.invoke(config, {
    localBuild: !check,
    showApiReportChanges: check,
    messageCallback: (message: ExtractorMessage) => {
      if (message.logLevel === ExtractorLogLevel.None) return;
      message.handled = true;
      const line = `  ${message.logLevel}: ${message.formatMessageWithLocation(REPO_ROOT)}`;
      if (message.logLevel === ExtractorLogLevel.Error) errors.push(line);
      else if (message.logLevel !== ExtractorLogLevel.Verbose) console.log(line);
    },
  });

  return {
    entry,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    apiReportChanged: result.apiReportChanged,
    errors,
  };
}

function main(): void {
  const check = process.argv.slice(2).includes('--check');
  const entries = entryPoints();
  for (const entry of entries) {
    if (!fs.existsSync(entry.typesPath)) {
      console.error(`api-report: ${entry.typesPath} does not exist - run \`npm run build\` first`);
      process.exit(1);
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-api-report-'));
  try {
    fs.mkdirSync(API_DIR, { recursive: true });
    const failures: string[] = [];
    for (const entry of entries) {
      console.log(`api-report: ${check ? 'checking' : 'writing'} api/${entry.name}.api.md (${entry.subpath})`);
      const r = runEntry(entry, check, tempDir);
      for (const line of r.errors) console.error(line);
      if (r.errorCount > 0) failures.push(`${entry.name}: ${r.errorCount} error(s)`);
      if (check && r.apiReportChanged) {
        showReportDiff(entry, tempDir);
        failures.push(`${entry.name}: api/${entry.name}.api.md is out of date - run \`npm run api:update\` and commit the diff`);
      }
    }
    if (failures.length > 0) {
      console.error(`\napi-report: ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} failed:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\napi-report: ${check ? 'all' : 'wrote'} ${entries.length} report(s) ${check ? 'are up to date' : `in ${path.relative(REPO_ROOT, API_DIR)}/`}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
