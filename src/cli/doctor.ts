/**
 * `loushy doctor [agent.yaml|json] [--json]` - first-run diagnostic.
 *
 * Thin wrapper over the pure core in doctorCore.ts: builds the real
 * DoctorEnvironment (process, fs, module resolution, fetch, Docker),
 * renders the report and returns the exit code (1 if any check failed).
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { MissingPeerDependencyError, loadOptionalPeer } from '../providers/optionalPeer';
import { loadSpec } from '../spec/loadSpec';
import { resolveSpecTool } from '../spec/specToAgent';
import { runDoctor } from './doctorCore';
import { renderJson, renderReport } from './doctorRender';
import type { DoctorEnvironment, SdkManifest } from './doctorTypes';

const DOCKER_TIMEOUT_MS = 2000;

export interface DoctorArgs {
  specPath?: string;
  json: boolean;
}

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  return {
    specPath: argv.find((arg) => !arg.startsWith('--')),
    json: argv.includes('--json'),
  };
}

/** Walks up from a resolved entry file to the package.json named `name`. */
function findPackageJson(entry: string, name: string): string | null {
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === name) {
      return candidate;
    }
  }
  return null;
}

/** Version of `name` as Node would resolve it from `cwd`, or null when it is not installed. */
function resolveVersion(cwd: string, name: string): string | null {
  const require = createRequire(path.join(cwd, 'noop.js'));
  // The first specifier can land on a nested package.json (the MCP SDK's exports map sends
  // `<name>/package.json` to dist/cjs/package.json), so walk up to the manifest named `name`.
  // Not installed, or "exports" hides both specifiers: null.
  for (const specifier of [`${name}/package.json`, name]) {
    try {
      const manifest = findPackageJson(require.resolve(specifier), name);
      if (manifest) return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    } catch {
      // try the next specifier
    }
  }
  return null;
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  if (/[\\/]/.test(command)) return fs.existsSync(command);
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) =>
    ['', ...extensions].some((ext) => fs.existsSync(path.join(dir, command + ext)))
  );
}

async function dockerReachable(): Promise<boolean> {
  let Docker: typeof import('dockerode');
  try {
    Docker = (await loadOptionalPeer('dockerode', () => import('dockerode'))).default;
  } catch (error) {
    // Without the optional dockerode peer there is no way to ask; its own check reports that.
    if (error instanceof MissingPeerDependencyError) return false;
    throw error;
  }
  const ping = new Docker().ping().then(() => true);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DOCKER_TIMEOUT_MS).unref());
  return Promise.race([ping, timeout]);
}

function readSdkManifest(): SdkManifest {
  // dist/cli/doctor.js and src/cli/doctor.ts both sit two levels below the package root.
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

/** The real DoctorEnvironment for the current process. */
export function buildEnvironment(args: DoctorArgs, cwd: string = process.cwd()): DoctorEnvironment {
  const resolveSpecFile = (file: string) => path.resolve(cwd, file);
  return {
    nodeVersion: process.versions.node,
    env: process.env,
    sdk: readSdkManifest(),
    resolvePackageVersion: (name) => resolveVersion(cwd, name),
    specPath: args.specPath ? resolveSpecFile(args.specPath) : undefined,
    loadSpec,
    resolveTool: resolveSpecTool,
    commandExists: (command) => commandExists(command, process.env),
    fetch: (url, init) => fetch(url, init),
    dockerReachable,
  };
}

/** Runs the command and prints the report; resolves to the process exit code. */
export async function runDoctorCommand(
  argv: string[],
  env?: DoctorEnvironment,
  write: (text: string) => void = (text) => console.log(text)
): Promise<number> {
  const args = parseDoctorArgs(argv);
  const report = await runDoctor(env ?? buildEnvironment(args));
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  write(args.json ? renderJson(report) : renderReport(report, { color }));
  return report.exitCode;
}
