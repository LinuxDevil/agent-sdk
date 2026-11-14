/**
 * workspaceSdk: finds the SDK install a workspace's runs should execute
 * under (PLAN §19.4 "Selection per workspace").
 *
 * The lookup is Node's own algorithm done by hand: the SDK's `exports`
 * map does not expose `./package.json`, so `require.resolve(
 * '@lousho/build-ai-agent/package.json')` throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * on every supported version. Walking `node_modules` upwards from the
 * workspace root (nearest hit wins) matches what `import` would resolve.
 *
 * Two package names are accepted: `@linuxdevil/lousho`, the scoped
 * name the package ships under, and `lousho`, the pre-rename name kept
 * for projects that still depend on it.
 * the package ships under today - a project on either gets its own SDK
 * bridged. A workspace that IS an SDK checkout (`source: 'self'`) uses
 * its own `bin/lousho.js`; `built` tells the selector whether `dist/`
 * exists - an unbuilt checkout falls back to Studio's in-process host.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, parse } from 'node:path';

/** Package names the SDK answers to: the scoped future name, then today's `lousho`. */
const SDK_PACKAGE_NAMES = ['@linuxdevil/lousho', '@linuxdevil/lousho'] as const;

/** The project's own SDK install, as the bridge spawns it. */
export interface WorkspaceSdk {
  /** The SDK's `package.json` `version`. */
  version: string;
  /** Real path of the SDK package folder. */
  packageDir: string;
  /** `<packageDir>/bin/lousho.js` - spawned as `node <binPath> bridge`. */
  binPath: string;
  /** `'self'` when the workspace root IS the SDK checkout, else `'node_modules'`. */
  source: 'node_modules' | 'self';
  /** `<packageDir>/dist/cli/bridge.mjs` exists - the checkout has been built. */
  built: boolean;
}

interface SdkPackageJson {
  name?: string;
  version?: string;
}

function readPackageJson(dir: string): SdkPackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as SdkPackageJson;
  } catch {
    return undefined;
  }
}

function isSdkPackageJson(pkg: SdkPackageJson | undefined): boolean {
  return pkg !== undefined && (SDK_PACKAGE_NAMES as readonly string[]).includes(pkg.name ?? '');
}

function sdkAt(packageDir: string, source: WorkspaceSdk['source']): WorkspaceSdk | undefined {
  const binPath = join(packageDir, 'bin', 'lousho.js');
  if (!existsSync(binPath)) return undefined;
  const version = readPackageJson(packageDir)?.version;
  if (version === undefined) return undefined;
  return {
    version,
    packageDir,
    binPath,
    source,
    built: existsSync(join(packageDir, 'dist', 'cli', 'bridge.mjs')),
  };
}

/**
 * Finds the SDK a workspace runs under, or `undefined` when it has none
 * (or the install lacks `bin/lousho.js`). Nearest `node_modules` hit
 * wins; the workspace's own checkout wins over any install.
 */
export function findWorkspaceSdk(root: string): WorkspaceSdk | undefined {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return undefined;
  }
  if (isSdkPackageJson(readPackageJson(real))) {
    return sdkAt(real, 'self');
  }
  for (let dir = real, prev = ''; dir !== prev; prev = dir, dir = parse(dir).dir) {
    for (const name of SDK_PACKAGE_NAMES) {
      const pkgDir = join(dir, 'node_modules', ...name.split('/'));
      // The directory name alone is not proof: verify the manifest's own
      // `name` (a junction to the SDK checkout carries `@linuxdevil/lousho`
      // or the legacy `lousho`).
      if (!isSdkPackageJson(readPackageJson(pkgDir))) continue;
      try {
        const sdk = sdkAt(realpathSync(pkgDir), 'node_modules');
        if (sdk !== undefined) return sdk;
      } catch {
        // An unreadable symlinked install is not an SDK.
      }
    }
  }
  return undefined;
}
