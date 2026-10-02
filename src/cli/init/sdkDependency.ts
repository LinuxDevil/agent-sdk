/**
 * How the generated project depends on `@lousho/build-ai-agent`.
 *
 * Normally a semver range of the version that generated it. For local
 * development (and the scaffolder's own e2e test) `--sdk-path` /
 * `LOUSHO_SDK_PATH` points at an SDK checkout or a packed `.tgz` instead, and
 * the project depends on a tarball copied next to its package.json.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigurationError } from '../../execution/errors';

/** The fields of the SDK's own package.json that generation needs. */
export interface SdkManifest {
  version: string;
  peerDependencies?: Record<string, string>;
}

function isTarball(file: string): boolean {
  return /\.(tgz|tar\.gz)$/i.test(file);
}

/** `npm pack`s the SDK checkout at `sdkRoot` into `dest`; returns the tarball's file name. */
function packSdk(sdkRoot: string, dest: string): string {
  // execSync runs through the shell, which is what lets it find npm's .cmd shim on
  // Windows; `dest` is quoted and comes from the caller, not from a remote source.
  const output = execSync(`npm pack --pack-destination ${JSON.stringify(dest)}`, { cwd: sdkRoot, encoding: 'utf8' });
  return output.trim().split(/\r?\n/).pop()!.trim();
}

/** Puts a tarball of the SDK at `sdkPath` (a checkout or a .tgz) into `projectDir`; returns its file name. */
function vendorSdk(sdkPath: string, projectDir: string): string {
  const resolved = path.resolve(sdkPath);
  if (!fs.existsSync(resolved)) {
    throw new ConfigurationError(`lousho init: --sdk-path '${sdkPath}' does not exist. Pass an SDK checkout directory or a packed .tgz file.`, 'sdk-path');
  }
  fs.mkdirSync(projectDir, { recursive: true });
  if (fs.statSync(resolved).isDirectory()) return packSdk(resolved, projectDir);
  if (!isTarball(resolved)) {
    throw new ConfigurationError(`lousho init: --sdk-path '${sdkPath}' is a file but not a .tgz tarball. Pass a checkout directory or a packed .tgz file.`, 'sdk-path');
  }
  fs.copyFileSync(resolved, path.join(projectDir, path.basename(resolved)));
  return path.basename(resolved);
}

/**
 * The `dependencies["@lousho/build-ai-agent"]` value for the generated
 * project: a caret range of `version` (e.g. `^1.2.3`), or `file:./<tarball>` when `sdkPath` is given
 * (which also writes the tarball into `projectDir`).
 */
export function resolveSdkDependency(version: string, projectDir: string, sdkPath?: string): string {
  return sdkPath ? `file:./${vendorSdk(sdkPath, projectDir)}` : `^${version}`;
}
