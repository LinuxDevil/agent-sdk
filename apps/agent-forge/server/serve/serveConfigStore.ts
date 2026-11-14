/**
 * ServeConfigStore - the Studio-global `/serve/<id>` switch (X02a), one
 * JSON file (`studioPaths().serve`, today `<studioHome>/serve.json`).
 *
 * Per agent it keeps `{ enabled, token, allowedOrigins }`: the token is
 * minted on first read (so `GET /agents/:id/serve` can mask it before the
 * user ever enables serving), `put` patches either field, and
 * `rotateToken` replaces the bearer - the serve router drops its cached
 * route handler so the old token stops working at once.
 *
 * Every read-modify-write runs inside `withAgentLock('__serve__')` and
 * writes through `writeJsonAtomic`, the same discipline AlertStore uses,
 * so parallel PUTs both land and a reader only ever sees a complete file.
 */
import { randomBytes } from 'node:crypto';
import { readJsonFile, withAgentLock, writeJsonAtomic } from '../storage/atomic';
import type { ServeAgentConfig } from '../../shared/wireTypes';

/** One agent's serve entry as stored on disk. */
export interface ServeAgentEntry extends ServeAgentConfig {
  /** The bearer `/serve/<id>/*` callers present; `auth: token` on the SDK route handler. */
  token: string;
  /**
   * The widget key (X04b): a narrower credential the `<forge-chat>` embed
   * carries - `fwk_`-prefixed, accepted only on `POST /serve/<id>/chat`
   * from an allowed origin. `null` until the user creates one.
   */
  widgetKey: string | null;
}

/** The on-disk shape: schema-versioned so a later migration has a marker. */
interface ServeFile {
  schemaVersion: 1;
  agents: Record<string, ServeAgentEntry>;
}

/** The mutex key serializing every serve-config read-modify-write. */
const SERVE_LOCK = '__serve__';

/** The most `allowedOrigins` one agent may carry (the ticket's cap). */
export const MAX_SERVE_ORIGINS = 10;

/** A `put`/`rotateToken` input the store refuses - the route maps it to 400 `LOUSHO_REQUEST_INVALID`. */
export class ServeConfigInvalidError extends Error {}

/** A fresh serve bearer, same entropy as the studio token. */
function mintServeToken(): string {
  return randomBytes(24).toString('base64url');
}

/** A fresh widget key (X04b): `fwk_`-prefixed so logs and users can tell it from the serve token. */
function mintWidgetKey(): string {
  return `fwk_${randomBytes(24).toString('base64url')}`;
}

/** The entry a never-configured agent starts from. */
function freshEntry(): ServeAgentEntry {
  return { enabled: false, token: mintServeToken(), allowedOrigins: [], widgetKey: null };
}

/**
 * `raw` as a storable origin (`scheme://host[:port]`, lower-case) or
 * `null` when it isn't an http(s) URL with no path - `https://app.example`
 * and `https://app.example/` both normalize to `https://app.example`.
 */
export function normalizeServeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/** The validated `allowedOrigins` list a `put` patch asks for, or throws {@link ServeConfigInvalidError}. */
function checkedOrigins(input: unknown): string[] {
  if (!Array.isArray(input)) throw new ServeConfigInvalidError('allowedOrigins must be an array of origins');
  if (input.length > MAX_SERVE_ORIGINS) {
    throw new ServeConfigInvalidError(`allowedOrigins accepts at most ${MAX_SERVE_ORIGINS} entries`);
  }
  const origins: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw new ServeConfigInvalidError('allowedOrigins entries must be strings');
    const origin = normalizeServeOrigin(raw);
    if (origin === null) {
      throw new ServeConfigInvalidError(`'${raw}' is not an http(s) origin without a path`);
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export class ServeConfigStore {
  constructor(private readonly file: string) {}

  private async readAll(): Promise<ServeFile> {
    const file = await readJsonFile<ServeFile>(this.file);
    const data = file ?? { schemaVersion: 1, agents: {} };
    // Entries written before X04b have no `widgetKey`; normalize on read.
    for (const entry of Object.values(data.agents)) {
      entry.widgetKey ??= null;
    }
    return data;
  }

  /**
   * The agent's entry, creating `{ enabled: false, fresh token, [] }` on
   * first read so the status route can mask a token that already exists.
   */
  async get(agentId: string): Promise<ServeAgentEntry> {
    return withAgentLock(SERVE_LOCK, async () => {
      const file = await this.readAll();
      const existing = file.agents[agentId];
      if (existing !== undefined) return existing;
      const entry = freshEntry();
      file.agents[agentId] = entry;
      await writeJsonAtomic(this.file, file);
      return entry;
    });
  }

  /** Applies `patch`'s present fields (`enabled`, `allowedOrigins`) and returns the stored entry. */
  async put(agentId: string, patch: Partial<ServeAgentConfig>): Promise<ServeAgentEntry> {
    return withAgentLock(SERVE_LOCK, async () => {
      const file = await this.readAll();
      const current = file.agents[agentId] ?? freshEntry();
      const next: ServeAgentEntry = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
        token: current.token,
        allowedOrigins: patch.allowedOrigins !== undefined ? checkedOrigins(patch.allowedOrigins) : current.allowedOrigins,
        widgetKey: current.widgetKey ?? null,
      };
      file.agents[agentId] = next;
      await writeJsonAtomic(this.file, file);
      return next;
    });
  }

  /**
   * The locked read-modify-write `rotateToken`/`createWidgetKey` share:
   * `change` sees the stored (or fresh) entry and returns the entry to
   * persist plus the raw secret to hand back.
   */
  private async rotateSecret(
    agentId: string,
    change: (current: ServeAgentEntry) => { entry: ServeAgentEntry; secret: string }
  ): Promise<string> {
    return withAgentLock(SERVE_LOCK, async () => {
      const file = await this.readAll();
      const current = file.agents[agentId] ?? freshEntry();
      const { entry, secret } = change(current);
      file.agents[agentId] = entry;
      await writeJsonAtomic(this.file, file);
      return secret;
    });
  }

  /** Replaces the agent's bearer and returns the new raw token. */
  async rotateToken(agentId: string): Promise<string> {
    return this.rotateSecret(agentId, (current) => {
      const token = mintServeToken();
      return { entry: { ...current, token }, secret: token };
    });
  }

  /** Creates or rotates the agent's widget key and returns the raw `fwk_` key (X04b). */
  async createWidgetKey(agentId: string): Promise<string> {
    return this.rotateSecret(agentId, (current) => {
      const widgetKey = mintWidgetKey();
      return { entry: { ...current, widgetKey }, secret: widgetKey };
    });
  }

  /** Revokes the agent's widget key; the entry stays otherwise untouched. */
  async revokeWidgetKey(agentId: string): Promise<void> {
    await withAgentLock(SERVE_LOCK, async () => {
      const file = await this.readAll();
      const current = file.agents[agentId];
      if (current === undefined || current.widgetKey === null) return;
      file.agents[agentId] = { ...current, widgetKey: null };
      await writeJsonAtomic(this.file, file);
    });
  }
}
