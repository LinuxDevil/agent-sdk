/**
 * Studio-global file locations (`studioPaths()`).
 *
 * Some Studio state belongs to the user, not to any one workspace:
 * settings, secrets, Author sessions, the pass spend log, the workspace
 * registry itself. Those files live under the Studio home directory, and
 * their paths come from here so no code joins `baseDir` with `.lousho`
 * ad hoc. Today `home` is still `<launchDir>/.lousho` (the files stay
 * exactly where they were); moving it to `~/.lousho/studio` is a later
 * change of one default, not a repo-wide rewrite.
 *
 * `studioPaths()` is process-wide and set once while wiring
 * (`createApp`/`startStudioServer` call `configureStudioHome`). Request
 * handlers must never call it: build the stores that need these paths at
 * wiring time and close over them, so a request's workspace can't change
 * which global file a handler touches.
 */
import * as path from 'node:path';

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
