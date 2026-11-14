import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * W03a moved the Studio-home default to `~/.lousho/studio`
 * (`LOUSHO_STUDIO_HOME` overrides it). Server tests must never write a
 * real user home, so every test file gets its own temp home; tests that
 * need a specific one pass `studioHome`/set the env var themselves.
 */
process.env.LOUSHO_STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-studio-home-'));
