import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load the repo-root .env (where OPENROUTER_API_KEY lives) into process.env
 * without overwriting anything already set. Audit harnesses run from audit/,
 * so the root .env is one directory up.
 */
export function loadAuditEnv(): void {
  for (const p of [join(process.cwd(), '../.env'), join(process.cwd(), '.env')]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadAuditEnv();

export const LIVE_MODEL = process.env.AUDIT_MODEL ?? 'openrouter/openai/gpt-4o-mini';
export const hasLiveKey = Boolean(process.env.OPENROUTER_API_KEY);

/** Log a labelled result line in the shared audit format. */
export function report(label: string, ok: boolean, detail: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} :: ${detail}`);
}
