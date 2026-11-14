/**
 * Studio-global file locations (`studioPaths()`).
 *
 * Some Studio state belongs to the user, not to any one workspace:
 * settings, secrets, Author sessions, the pass spend log, the workspace
 * registry itself. Those files live under the Studio home directory, and
 * their paths come from here so no code joins `baseDir` with `.lousho`
 * ad hoc. The home is `~/.lousho/studio` (or `LOUSHO_STUDIO_HOME`) -
 * `defaultStudioHome()` - so global state survives across projects;
 * `legacyImport.ts` offers to copy a workspace's old project-level
 * settings/secrets into it once.
 *
 * `studioPaths()` is process-wide and set once while wiring
 * (`createApp`/`startStudioServer` call `configureStudioHome`). Request
 * handlers must never call it: build the stores that need these paths at
 * wiring time and close over them, so a request's workspace can't change
 * which global file a handler touches.
 */
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Studio home directory when the caller names none:
 * `LOUSHO_STUDIO_HOME` (resolved to absolute) when set, else
 * `<os.homedir()>/.lousho/studio`. Read once while wiring - tests set the
 * env var (or pass `studioHome`) so they never touch a real home.
 */
export function defaultStudioHome(): string {
  const env = process.env.LOUSHO_STUDIO_HOME;
  return env !== undefined && env.trim() !== '' ? path.resolve(env) : path.join(os.homedir(), '.lousho', 'studio');
}

/** Every Studio-global file, derived from the Studio home directory. */
export interface StudioPaths {
  /** The Studio home directory every other key lives under. */
  home: string;
  /** The workspace registry. */
  workspaces: string;
  /** Settings profiles. */
  settings: string;
  /** Encrypted provider keys. */
  secrets: string;
  /** The secrets encryption key. */
  secretsKey: string;
  /** Directory of Author session files. */
  sessions: string;
  /** Append-only pass spend log. */
  spend: string;
  /** Inbox alert records. */
  alerts: string;
  /** Published-agent serve config. */
  serve: string;
  /** One-time legacy settings/secrets import records, per workspace id. */
  legacyImports: string;
}

/** The `StudioPaths` for a given home directory - pure; sets nothing. */
export function studioPathsFor(home: string): StudioPaths {
  return {
    home,
    workspaces: path.join(home, 'workspaces.json'),
    settings: path.join(home, 'settings.json'),
    secrets: path.join(home, 'secrets.json'),
    secretsKey: path.join(home, 'secrets.key'),
    sessions: path.join(home, 'assistant', 'sessions'),
    spend: path.join(home, 'passes', 'spend.jsonl'),
    alerts: path.join(home, 'inbox', 'alerts.json'),
    serve: path.join(home, 'serve.json'),
    legacyImports: path.join(home, 'legacy-imports.json'),
  };
}

let current: StudioPaths | undefined;

/**
 * Sets the process-wide Studio home and returns its paths. `createApp`
 * and `startStudioServer` call it exactly once while wiring, before any
 * request is served.
 */
export function configureStudioHome(home: string): StudioPaths {
  current = studioPathsFor(home);
  return current;
}

/** The configured paths; throws until `configureStudioHome` has run (i.e. before `createApp`). */
export function studioPaths(): StudioPaths {
  if (!current) {
    throw new Error('Studio home is not configured; createApp() sets it.');
  }
  return current;
}
