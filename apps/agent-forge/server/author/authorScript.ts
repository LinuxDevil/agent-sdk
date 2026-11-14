/**
 * The X08 e2e hook: `LOUSHO_FORGE_AUTHOR_SCRIPT=<file>` makes the Agent
 * Author run a scripted `mockModel` instead of resolving a provider key,
 * so the Playwright smoke (`e2e/forgeBuilder.spec.ts`) drives a real
 * propose -> apply -> save -> publish flow with no API keys and no
 * network. The file holds a JSON array of `MockTurnObject`s; turns are
 * replayed with `onExhausted: 'repeat-last'` so a second Author turn does
 * not fail.
 *
 * `loadAuthorScript` runs once at server start (`createApp`): it reads the
 * file eagerly so a bad path or bad JSON fails startup with an error that
 * names the file, and it is ignored - with one warning - only when
 * `NODE_ENV === 'production'` without `LOUSHO_STUDIO_E2E=1`. Never set
 * outside e2e.
 */
import { readFileSync } from 'node:fs';
import { mockModel, type MockModel, type MockTurnObject } from '@linuxdevil/lousho/testing';
import type { LLMProvider } from '@linuxdevil/lousho';

/** The env var naming the JSON file of scripted Author turns. */
export const AUTHOR_SCRIPT_ENV = 'LOUSHO_FORGE_AUTHOR_SCRIPT';

/** The e2e flag that keeps the hook live under `NODE_ENV=production`. */
const E2E_FLAG_ENV = 'LOUSHO_STUDIO_E2E';

let installed: MockModel | undefined;

function isTurnArray(value: unknown): value is MockTurnObject[] {
  return Array.isArray(value) && value.every((turn) => turn !== null && typeof turn === 'object');
}

/**
 * Reads {@link AUTHOR_SCRIPT_ENV} once and installs the scripted provider.
 * Returns the mock model, or `undefined` when the env var is unset or the
 * production guard applies. Throws an `Error` naming the file when it
 * cannot be read or parsed - the caller is server startup, so the throw
 * is the startup error.
 */
export function loadAuthorScript(env: NodeJS.ProcessEnv = process.env): MockModel | undefined {
  installed = undefined;
  const file = env[AUTHOR_SCRIPT_ENV];
  if (file === undefined || file === '') return undefined;
  if (env.NODE_ENV === 'production' && env[E2E_FLAG_ENV] !== '1') {
    console.warn(
      `[agent-forge] ${AUTHOR_SCRIPT_ENV} is set but ignored: NODE_ENV=production without ${E2E_FLAG_ENV}=1.`
    );
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${AUTHOR_SCRIPT_ENV} ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isTurnArray(parsed)) {
    throw new Error(`${AUTHOR_SCRIPT_ENV} ${file}: expected a JSON array of mock turns.`);
  }
  installed = mockModel(parsed, { onExhausted: 'repeat-last' });
  return installed;
}

/** The installed scripted provider, or `undefined` when the hook is off. */
export function authorScriptProvider(): LLMProvider | undefined {
  return installed;
}

/** Whether the scripted provider is installed (the settings payload's `ready` shortcut). */
export function authorScriptActive(): boolean {
  return installed !== undefined;
}
