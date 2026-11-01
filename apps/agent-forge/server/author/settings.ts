/**
 * The Agent Author's settings: which `provider/model` the chat turns and
 * the draft-review pass run on, and whether the review runs at all. Stored
 * as a sparse `author` object inside `settings.json` (SettingsStore keeps
 * the profiles untouched); `readAuthorSettings` merges the stored values
 * over {@link DEFAULT_AUTHOR_SETTINGS} so older files read as the
 * defaults.
 *
 * `GET/PUT /settings/author` also reports `ready`: whether the configured
 * Author model resolves to a usable provider right now, so the client can
 * show the setup card instead of a dead chat (PLAN 16.4).
 */
import type { Express } from 'express';
import type { AuthorSettings, AuthorSettingsPayload } from '../../shared/authorWire';
import { sendError } from '../http/routeUtils';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import { resolveAuthorProvider } from './provider';

/** The Author's out-of-the-box model choices (PLAN 16 decision 4). */
// fallow-ignore-next-line unused-export -- part of the author settings API the AA23 Settings card consumes
export const DEFAULT_AUTHOR_SETTINGS: AuthorSettings = {
  model: 'anthropic/claude-sonnet-5-5',
  reviewModel: 'anthropic/claude-haiku-5-5',
  reviewEnabled: true,
};

/** Every model field must be `provider/model` (the provider is the segment before the first `/`). */
const AUTHOR_MODEL_RE = /^[a-z0-9-]+\/.+$/;

/** The exact 400 copy a malformed `model`/`reviewModel` gets. */
const INVALID_MODEL_MESSAGE = 'model must look like provider/model.';

/** The effective Author settings: the stored patch over the defaults. */
export function readAuthorSettings(store: SettingsStore): AuthorSettings {
  const stored = store.getAuthor();
  return {
    model: stored.model ?? DEFAULT_AUTHOR_SETTINGS.model,
    reviewModel: stored.reviewModel ?? DEFAULT_AUTHOR_SETTINGS.reviewModel,
    reviewEnabled: stored.reviewEnabled ?? DEFAULT_AUTHOR_SETTINGS.reviewEnabled,
  };
}

/** Stores `patch` (sparse) and returns the effective settings. */
// fallow-ignore-next-line unused-export -- used by registerAuthorSettingsRoutes below and by the AA23 Settings card
export function writeAuthorSettings(store: SettingsStore, patch: Partial<AuthorSettings>): AuthorSettings {
  store.setAuthor(patch);
  return readAuthorSettings(store);
}

/** The effective settings plus `ready`/`missingKeyFor` from resolving the Author model. */
function authorSettingsPayload(store: SettingsStore, secrets: SecretsStore): AuthorSettingsPayload {
  const settings = readAuthorSettings(store);
  const resolved = resolveAuthorProvider(settings.model, secrets);
  return resolved.ok
    ? { ...settings, ready: true }
    : { ...settings, ready: false, missingKeyFor: resolved.provider };
}

/** A validated `PUT /settings/author` body, or the 400 message. */
function parseAuthorPatch(body: unknown): { ok: true; patch: Partial<AuthorSettings> } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true, patch: {} };
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object.' };
  const candidate = body as { model?: unknown; reviewModel?: unknown; reviewEnabled?: unknown };
  for (const field of ['model', 'reviewModel'] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== 'string' || !AUTHOR_MODEL_RE.test(value))) {
      return { ok: false, error: INVALID_MODEL_MESSAGE };
    }
  }
  if (candidate.reviewEnabled !== undefined && typeof candidate.reviewEnabled !== 'boolean') {
    return { ok: false, error: 'reviewEnabled must be a boolean.' };
  }
  const patch: Partial<AuthorSettings> = {};
  if (candidate.model !== undefined) patch.model = candidate.model as string;
  if (candidate.reviewModel !== undefined) patch.reviewModel = candidate.reviewModel as string;
  if (candidate.reviewEnabled !== undefined) patch.reviewEnabled = candidate.reviewEnabled;
  return { ok: true, patch };
}

/**
 * `GET/PUT /settings/author`: read or patch the Author's model choices.
 * Both answer the {@link AuthorSettingsPayload} (settings + `ready`), so
 * the client always knows whether the chat can run.
 */
export function registerAuthorSettingsRoutes(
  app: Express,
  deps: { settings: SettingsStore; secrets: SecretsStore }
): void {
  app.get('/settings/author', (_req, res) => {
    res.json(authorSettingsPayload(deps.settings, deps.secrets));
  });

  app.put('/settings/author', (req, res) => {
    const parsed = parseAuthorPatch(req.body);
    if (!parsed.ok) {
      sendError(res, 400, parsed.error, 'INVALID_INPUT');
      return;
    }
    writeAuthorSettings(deps.settings, parsed.patch);
    res.json(authorSettingsPayload(deps.settings, deps.secrets));
  });
}
