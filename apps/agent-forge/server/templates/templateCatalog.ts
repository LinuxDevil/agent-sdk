/**
 * Template catalog and routes - the agent templates shipped inside the
 * SDK package at `templates/<id>/{template.json,spec.yaml,README.md}`.
 * `GET /templates` lists their `template.json` summaries,
 * `GET /templates/:id` answers the full `TemplateDetail` (summary +
 * parsed spec v2 + README text), and `POST /agents { from: { template } }`
 * creates from `get()`'s spec (routes/agentRoutes.ts).
 *
 * A folder only counts as a template when `template.json` parses with a
 * string `id` equal to the folder name, string `title`/`description`/
 * `category`, a string `tags` array and a `requires` list inside
 * {@link RequirementKind}, AND `spec.yaml` loads through `loadSpecV2`.
 * Anything else is skipped with one `console.warn`, so a broken template
 * never takes the list down; a missing `README.md` is fine (`readme: ''`)
 * and a missing templates dir makes the list empty.
 *
 * The catalog is Studio-global (the folder ships in the SDK package), so
 * it is built once per app and shared between these routes and the agent
 * create route - the workspace seam (workspace/context.ts) does not apply
 * to it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Express } from 'express';
import { loadSpecV2, type AgentSpecV2 } from 'lousho';
import type { RequirementKind, TemplateDetail, TemplateSummary } from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { sdkRootDir } from '../sdkRoot';

/**
 * The template id rule: a lowercase slug. Guards the `:id` route param
 * (a bad id is a 400 that never reaches the filesystem) and is also what
 * `template.json`'s `id` must equal relative to its folder name.
 */
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every kind a template's `requires` list may name - mirrors {@link RequirementKind}. */
const REQUIREMENT_KINDS: readonly RequirementKind[] = ['provider_key', 'secret', 'mcp', 'tool', 'model'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** `data` as the TemplateSummary of folder `id`, or the reason it is not a valid template.json. */
function parseTemplateJson(data: unknown, id: string): TemplateSummary | string {
  if (!isObject(data)) return 'template.json is not an object';
  if (typeof data.id !== 'string' || data.id !== id) {
    return "template.json 'id' must be a string equal to the folder name";
  }
  if (typeof data.title !== 'string') return "template.json 'title' must be a string";
  if (typeof data.description !== 'string') return "template.json 'description' must be a string";
  if (typeof data.category !== 'string') return "template.json 'category' must be a string";
  if (!isStringArray(data.tags)) return "template.json 'tags' must be a string array";
  if (!isStringArray(data.requires) || !data.requires.every((kind) => REQUIREMENT_KINDS.includes(kind as RequirementKind))) {
    return `template.json 'requires' must be a string array containing only: ${REQUIREMENT_KINDS.join(', ')}`;
  }
  return {
    id,
    title: data.title,
    description: data.description,
    category: data.category,
    tags: data.tags,
    requires: data.requires as RequirementKind[],
  };
}

/** A template folder that passed every validity check: its summary and parsed spec (the README is read on demand). */
interface LoadedTemplate {
  summary: TemplateSummary;
  spec: AgentSpecV2;
}

/**
 * The shipped templates under one folder - read-only, so nothing in here
 * locks or writes. `list()`/`get()` re-read the folder on every call: six
 * small files, so caching would buy nothing and staleness would cost
 * correctness after a `lousho` upgrade.
 */
export class TemplateCatalog {
  private readonly dir: string;

  /**
   * `dir` overrides the lookup for tests and unusual layouts; the default
   * is `LOUSHO_TEMPLATES_DIR`, else `<sdkRoot>/templates` (sdkRootDir() -
   * `templates` ships in the npm package's `files`).
   */
  constructor(dir?: string) {
    this.dir = dir ?? process.env.LOUSHO_TEMPLATES_DIR ?? path.join(sdkRootDir(), 'templates');
  }

  /**
   * Every valid template's summary, sorted by category then title.
   * `[]` when the folder is missing or unreadable - Studio works without
   * shipped templates.
   */
  async list(): Promise<TemplateSummary[]> {
    const summaries: TemplateSummary[] = [];
    for (const id of await this.folderIds()) {
      const loaded = await this.loadTemplate(id);
      if (loaded !== undefined) summaries.push(loaded.summary);
    }
    return summaries.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }

  /**
   * One template's detail, or `undefined` when `id` names no valid
   * template. A malformed id returns `undefined` up front - the catalog
   * never builds a path outside `dir`.
   */
  async get(id: string): Promise<TemplateDetail | undefined> {
    if (!TEMPLATE_ID_RE.test(id)) return undefined;
    const loaded = await this.loadTemplate(id);
    if (loaded === undefined) return undefined;
    return { ...loaded, readme: await this.readReadme(id) };
  }

  /**
   * The template folders under `dir`: directory names that could be
   * template ids. Entries failing the id rule are not templates at all
   * (dotfiles, stray folders) and are skipped silently.
   */
  private async folderIds(): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((entry) => entry.isDirectory() && TEMPLATE_ID_RE.test(entry.name)).map((entry) => entry.name);
  }

  /** `dir/<id>` as a template, or `undefined` when the folder is absent (silent) or invalid (one warn). */
  private async loadTemplate(id: string): Promise<LoadedTemplate | undefined> {
    if (!fs.existsSync(path.join(this.dir, id))) return undefined;
    const summary = await this.readSummary(id);
    if (summary === undefined) return undefined;
    let spec: AgentSpecV2;
    try {
      spec = loadSpecV2(path.join(this.dir, id, 'spec.yaml'));
    } catch (error) {
      this.warn(id, `spec.yaml failed to load: ${(error as Error).message}`);
      return undefined;
    }
    return { summary, spec };
  }

  /** `dir/<id>/template.json` as a summary, or `undefined` (one warn) when unreadable or invalid. */
  private async readSummary(id: string): Promise<TemplateSummary | undefined> {
    let data: unknown;
    try {
      data = JSON.parse(await fs.promises.readFile(path.join(this.dir, id, 'template.json'), 'utf8'));
    } catch (error) {
      this.warn(id, `template.json could not be read: ${(error as Error).message}`);
      return undefined;
    }
    const parsed = parseTemplateJson(data, id);
    if (typeof parsed === 'string') {
      this.warn(id, parsed);
      return undefined;
    }
    return parsed;
  }

  /** `dir/<id>/README.md`, or `''` - a template without a README still counts. */
  private async readReadme(id: string): Promise<string> {
    try {
      return await fs.promises.readFile(path.join(this.dir, id, 'README.md'), 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.warn(id, `README.md could not be read: ${(error as Error).message}`);
      }
      return '';
    }
  }

  private warn(id: string, problem: string): void {
    console.warn(`[templates] skipping template '${id}': ${problem}`);
  }
}

/**
 * Registers `GET /templates` and `GET /templates/:id` on the app's one
 * catalog. The `:id` guard mirrors the `/agents/:id` one in app.ts:
 * mounted with `app.use` it also sees the `:id` of deeper paths like
 * `/templates/../x`, which the GET route alone would never match.
 */
export function registerTemplateRoutes(app: Express, catalog: TemplateCatalog): void {
  app.use('/templates/:id', (req, res, next) => {
    if (!TEMPLATE_ID_RE.test(paramId(req))) {
      sendError(res, 400, 'Invalid template id', 'LOUSHO_TEMPLATE_ID_INVALID');
      return;
    }
    next();
  });

  app.get(
    '/templates',
    asyncRoute(async (_req, res) => {
      res.json(await catalog.list());
    })
  );

  app.get(
    '/templates/:id',
    asyncRoute(async (req, res) => {
      const detail = await catalog.get(paramId(req));
      if (detail === undefined) {
        sendError(res, 404, `No template '${paramId(req)}'`, 'LOUSHO_TEMPLATE_NOT_FOUND');
        return;
      }
      res.json(detail);
    })
  );
}
