/**
 * The shipped `templates/` folder: six starter agents, each
 * `{ spec.yaml, README.md, template.json }`, every spec a valid AgentSpec v2
 * that compiles. Studio's Templates screen reads `template.json`; these tests
 * keep the three files of every template in step with each other and with the
 * v2 schema, so "New agent -> From template" always starts from a spec that
 * parses and builds.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { agentSpecV2Schema } from './schema';
import { isSecretRef } from './secrets';
import { compileSpec } from './specToAgent';
import type { AgentSpecV2 } from './types';

const TEMPLATE_IDS = ['docs-qa', 'inbox-triage', 'incident-responder', 'pr-reviewer', 'research-assistant', 'support-triage'] as const;

type TemplateId = (typeof TEMPLATE_IDS)[number];

const templatesDir = path.resolve(__dirname, '../../../templates');

/** The `template.json` shape Studio's Templates screen reads. */
interface TemplateJson {
  id: string;
  title: string;
  description: string;
  category: 'support' | 'engineering' | 'research' | 'productivity' | 'operations' | 'knowledge';
  tags: string[];
  requires: Array<'provider_key' | 'secret' | 'mcp' | 'tool' | 'model'>;
}

const CATEGORIES: readonly TemplateJson['category'][] = ['support', 'engineering', 'research', 'productivity', 'operations', 'knowledge'];
const REQUIREMENT_KINDS: readonly TemplateJson['requires'][number][] = ['provider_key', 'secret', 'mcp', 'tool', 'model'];
const README_SECTIONS = ['## What it needs', '## How it starts', '## Before you turn it on'] as const;

/** One template folder's three files, parsed: the spec through the v2 schema, the meta as TemplateJson. */
function loadTemplate(id: TemplateId): { spec: AgentSpecV2; meta: TemplateJson; readme: string } {
  const dir = path.join(templatesDir, id);
  const spec = agentSpecV2Schema.parse(parseYaml(readFileSync(path.join(dir, 'spec.yaml'), 'utf8')));
  const meta = JSON.parse(readFileSync(path.join(dir, 'template.json'), 'utf8')) as TemplateJson;
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  return { spec, meta, readme };
}

/** Whether `value` (already parsed spec data) holds a `{ secret: 'name' }` ref anywhere below it. */
function hasNamedSecretRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNamedSecretRef);
  if (typeof value !== 'object' || value === null) return false;
  if (isSecretRef(value)) return 'secret' in value;
  return Object.values(value).some(hasNamedSecretRef);
}

/** The spec with `triggers` removed: a trigger's secrets only matter when the user wires that trigger up. */
function specOutsideTriggers(spec: AgentSpecV2): Record<string, unknown> {
  const { triggers: _triggers, ...rest } = spec;
  return rest;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('templates/', () => {
  it('has exactly the six template folders, each holding exactly spec.yaml, README.md and template.json', () => {
    expect(readdirSync(templatesDir).sort()).toEqual([...TEMPLATE_IDS]);
    for (const id of TEMPLATE_IDS) {
      expect(readdirSync(path.join(templatesDir, id)).sort()).toEqual(['README.md', 'spec.yaml', 'template.json']);
    }
  });

  describe.each(TEMPLATE_IDS)('templates/%s', (id) => {
    it('has a spec.yaml that parses, with name and description matching template.json', () => {
      const { spec, meta } = loadTemplate(id);
      expect(spec.version).toBe(2);
      expect(spec.name).toBe(meta.title);
      expect(spec.description).toBe(meta.description);
    });

    it('has a spec that compiles', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'test');
      const { spec } = loadTemplate(id);
      const baseDir = mkdtempSync(path.join(tmpdir(), `lousho-template-${id}-`));
      await expect(compileSpec(spec, { baseDir, resolveSecret: async () => 'test' })).resolves.toBeDefined();
    });

    it('has a template.json matching TemplateJson, with secret required exactly when a { secret } ref sits outside triggers', () => {
      const { spec, meta } = loadTemplate(id);
      expect(meta.id).toBe(id);
      expect(typeof meta.title).toBe('string');
      expect(meta.title).not.toBe('');
      expect(typeof meta.description).toBe('string');
      expect(meta.description).not.toBe('');
      expect(CATEGORIES).toContain(meta.category);
      expect(meta.tags.length).toBeGreaterThanOrEqual(1);
      expect(meta.tags.length).toBeLessThanOrEqual(5);
      for (const tag of meta.tags) expect(tag).toBe(tag.toLowerCase());
      for (const kind of meta.requires) expect(REQUIREMENT_KINDS).toContain(kind);
      expect(meta.requires).toContain('provider_key');
      expect(meta.requires.includes('secret')).toBe(hasNamedSecretRef(specOutsideTriggers(spec)));
    });

    it('has a README that starts with the title and has the three sections in order', () => {
      const { meta, readme } = loadTemplate(id);
      expect(readme.startsWith(`# ${meta.title}\n`)).toBe(true);
      let previous = -1;
      for (const section of README_SECTIONS) {
        const at = readme.indexOf(`\n${section}\n`);
        expect(at).toBeGreaterThan(previous);
        previous = at;
      }
    });

    it('has an instructions block of 10-20 lines', () => {
      const { spec } = loadTemplate(id);
      if (typeof spec.instructions !== 'string') throw new Error('template instructions must be a string');
      const lines = spec.instructions.trimEnd().split('\n').length;
      expect(lines).toBeGreaterThanOrEqual(10);
      expect(lines).toBeLessThanOrEqual(20);
    });
  });
});
