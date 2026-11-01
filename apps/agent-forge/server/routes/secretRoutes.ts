/**
 * Named-secret routes - `GET /settings/secrets` and
 * `GET/PUT/DELETE /settings/secrets/:name` (Contract C).
 *
 * Named secrets are the Studio-global values a spec's
 * `{ secret: '<name>' }` refs resolve to at run time (the run host reads
 * them through `SecretsStore.getSecret` as its `resolveSecret`). They
 * live in `secrets.json`'s `named` map, encrypted exactly like the two
 * provider keys but managed separately so `/settings/providers` is
 * unchanged.
 *
 * This is a global route family (like the provider-key and profile
 * routes): secrets belong to the user, not to a workspace, so handlers
 * receive the app's one `SecretsStore` (built from `studioPaths()` at
 * wiring time) and never call `workspaceOf`.
 *
 * No response ever carries a stored value: GET answers the masked
 * `SecretStatus`, PUT answers the same after storing, DELETE answers
 * 204. Error bodies name the secret, never its value.
 */
import type { Express } from 'express';
import type { SecretStatus } from '../../shared/wireTypes';
import { paramId, sendError } from '../http/routeUtils';
import { MAX_SECRET_VALUE_LENGTH, SECRET_NAME_RE, type SecretsStore } from '../secretsStore';

/** The 400 for a `:name` that fails `SECRET_NAME_RE` (Contract C's row). */
const NAME_INVALID = {
  error: 'Secret names use letters, digits and underscores, and start with a letter or underscore.',
  code: 'LOUSHO_SECRET_NAME_INVALID',
} as const;

/** The 400 for a PUT body whose `value` fails the contract (1..16 384 chars, not all whitespace). */
const VALUE_INVALID = {
  error: "Request body must include a non-empty 'value' string of at most 16384 characters",
  code: 'LOUSHO_SECRET_VALUE_INVALID',
} as const;

/**
 * Registers the named-secret routes on `app` against the app's single
 * `SecretsStore`. Mounted next to the provider-key routes in `createApp`.
 */
export function registerSecretRoutes(app: Express, secrets: SecretsStore): void {
  // The Settings "Secrets" card's list: masked status of every stored
  // named secret, sorted by name.
  app.get('/settings/secrets', (_req, res) => {
    const statuses: SecretStatus[] = secrets.listSecrets();
    res.json(statuses);
  });

  app.get('/settings/secrets/:name', (req, res) => {
    const name = paramId(req, 'name');
    if (!SECRET_NAME_RE.test(name)) {
      sendError(res, 400, NAME_INVALID.error, NAME_INVALID.code);
      return;
    }
    res.json(secrets.secretStatus(name));
  });

  app.put('/settings/secrets/:name', (req, res) => {
    const name = paramId(req, 'name');
    if (!SECRET_NAME_RE.test(name)) {
      sendError(res, 400, NAME_INVALID.error, NAME_INVALID.code);
      return;
    }
    const { value } = req.body as { value?: unknown };
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_VALUE_LENGTH || !value.trim()) {
      sendError(res, 400, VALUE_INVALID.error, VALUE_INVALID.code);
      return;
    }
    // Answers the masked status, never the value just written.
    res.json(secrets.setSecret(name, value));
  });

  app.delete('/settings/secrets/:name', (req, res) => {
    const name = paramId(req, 'name');
    if (!SECRET_NAME_RE.test(name)) {
      sendError(res, 400, NAME_INVALID.error, NAME_INVALID.code);
      return;
    }
    secrets.removeSecret(name);
    res.status(204).end();
  });
}
