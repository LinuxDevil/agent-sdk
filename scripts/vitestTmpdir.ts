/**
 * Vitest global setup: points `os.tmpdir()` (TMPDIR / TMP / TEMP) of the test
 * workers and of every process they spawn at one fresh directory per run, and
 * removes it when the run ends. Scratch directories a test forgets to delete
 * (or that a killed subprocess leaves) then never pile up in the system /tmp.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-vitest-'));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
}
