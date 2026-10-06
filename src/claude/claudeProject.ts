/**
 * Claude-Code-compatible project context (claudeProject).
 *
 * A repository that already carries Claude Code's conventional files —
 * `CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, `.claude/rules/`,
 * `.claude/scratchpad/` — can be loaded as Lousho agent options without
 * duplicating anything into a Lousho-specific layout:
 *
 * ```ts
 * import { createAgent, claudeProject } from '@lousho/build-ai-agent';
 *
 * const project = await claudeProject('./my-repo', { provider });
 * const agent = createAgent({ provider, ...project });
 * ```
 *
 * What maps to what:
 *
 * - `CLAUDE.md` / `AGENTS.md` in the directory → `instructions`
 *   (both are concatenated when present).
 * - `.claude/rules/*.md` → appended to `instructions`, one `## <file>`
 *   section each, sorted by filename (Claude Code treats rules as
 *   always-on instruction files; simple frontmatter is stripped).
 * - `.claude/skills/<name>/SKILL.md` → `skills`, via {@link loadSkills} —
 *   the layouts are identical.
 * - `.claude/agents/*.md` → `subagents`: YAML frontmatter `name` and
 *   `description` are required, the markdown body becomes the sub-agent's
 *   `instructions`, and an optional `model` frontmatter selects its model.
 *   `tools` frontmatter is advisory in Claude Code; Lousho sub-agents share
 *   the lead's tools, so it is recorded on the manifest, not enforced.
 * - `.claude/scratchpad/` → a `scratchpad` tool in `tools` that reads,
 *   writes, appends and lists `*.md` notes inside that directory only.
 * - `.claude/commands/`, `.claude/settings*.json`, `.claude/mcp.json` → not
 *   loaded (no Lousho equivalent; slash commands map conceptually to
 *   [flows]). Listed on `manifest.ignored`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { createAgent, type SimpleAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { SDKError } from '../execution/errors';
import { loadSkills } from '../skills/loadSkills';
import type { Skill } from '../skills/defineSkill';
import type { LLMProvider } from '../providers/llm';

/** Options of {@link claudeProject}. */
export interface ClaudeProjectOptions {
  /** Provider the `.claude/agents` sub-agents run on (their `model` frontmatter wins when set). */
  provider?: LLMProvider;
  /** Model id the `.claude/agents` sub-agents run on (their `model` frontmatter wins). */
  model?: string;
  /** Also return a `scratchpad` tool even when `.claude/scratchpad/` does not exist yet (it is created on first write). */
  scratchpad?: boolean;
  /** Set false to skip `.claude/rules/*.md`. */
  rules?: boolean;
  /** Set false to skip `.claude/agents/*.md`. */
  agents?: boolean;
}

/** What `claudeProject` found in the directory. */
export interface ClaudeProjectManifest {
  /** The directory that was scanned (absolute). */
  dir: string;
  /** Which instruction files were loaded: `'CLAUDE.md'`, `'AGENTS.md'`. */
  instructionFiles: string[];
  /** `.claude/rules` files loaded, filenames sorted. */
  rules: string[];
  /** Skill names found under `.claude/skills`. */
  skills: string[];
  /** Sub-agent names built from `.claude/agents`. */
  subagents: string[];
  /** Whether a scratchpad tool was returned. */
  scratchpad: boolean;
  /** Conventional entries that exist but are not loaded (`commands/`, `settings.json`, `mcp.json`). */
  ignored: string[];
}

/** What {@link claudeProject} returns: fields that spread into `createAgent()`. */
export interface ClaudeProject {
  /** `CLAUDE.md`/`AGENTS.md` + `.claude/rules` sections; absent when none were found. */
  instructions?: string;
  /** Skills from `.claude/skills` (absent when the directory has none). */
  skills?: Skill[];
  /** Sub-agents built from `.claude/agents` (absent when none). */
  subagents?: Record<string, SimpleAgent>;
  /** The `scratchpad` tool when `.claude/scratchpad` exists or `scratchpad: true`. */
  tools?: DefinedTool[];
  /** What was found, ignored and loaded. */
  manifest: ClaudeProjectManifest;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function parseAgentFile(file: string, text: string): { name: string; description: string; model?: string; tools?: string; instructions: string } {
  const match = FRONTMATTER.exec(text);
  const fm = (match ? (parseYaml(match[1]) as Record<string, unknown>) ?? {} : {}) as Record<string, unknown>;
  const body = (match ? text.slice(match[0].length) : text).trim();
  const name = fm.name;
  const description = fm.description;
  if (typeof name !== 'string' || !name.trim() || typeof description !== 'string' || !description.trim()) {
    throw new SDKError(
      `claudeProject: '${file}' needs frontmatter with 'name' and 'description' (Claude Code sub-agent format).`,
      'LOUSHO_CONFIG_INVALID'
    );
  }
  if (!body) {
    throw new SDKError(`claudeProject: '${file}' has no instructions below its frontmatter.`, 'LOUSHO_CONFIG_INVALID');
  }
  return {
    name: name.trim(),
    description: description.trim(),
    model: typeof fm.model === 'string' ? fm.model : undefined,
    tools: typeof fm.tools === 'string' ? fm.tools : undefined,
    instructions: body,
  };
}

/** Reads the markdown files of a directory, sorted by filename; missing dir → []. */
async function readMarkdownDir(dir: string): Promise<{ file: string; text: string }[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (f) => ({ file: f, text: await readFile(path.join(dir, f), 'utf8') })));
}

function stripFrontmatter(text: string): string {
  const match = FRONTMATTER.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

const noteFile = (dir: string, name: string): string => {
  if (!/^[a-z0-9][a-z0-9-_]{0,60}$/i.test(name)) {
    throw new SDKError(
      `scratchpad: note name must be 1-61 characters of [a-z0-9-_], got '${name}'.`,
      'LOUSHO_CONFIG_INVALID'
    );
  }
  return path.join(dir, `${name}.md`);
};

function scratchpadTool(dir: string): DefinedTool {
  return defineTool({
    name: 'scratchpad',
    description: 'A persistent scratchpad of named markdown notes: write, append, read or list notes. Notes survive across runs.',
    input: z.object({
      action: z.enum(['write', 'append', 'read', 'list']),
      name: z.string().optional().describe('note name, [a-z0-9-_]; required for write/append/read'),
      content: z.string().optional().describe('required for write/append'),
    }),
    execute: async ({ action, name, content }) => {
      if (action === 'list') {
        try {
          return { notes: (await readdir(dir)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) };
        } catch {
          return { notes: [] };
        }
      }
      if (!name) throw new SDKError(`scratchpad: '${action}' needs a note name.`, 'LOUSHO_CONFIG_INVALID');
      const file = noteFile(dir, name);
      if (action === 'read') {
        try {
          return { content: await readFile(file, 'utf8') };
        } catch {
          return { content: null, error: `no note named '${name}'` };
        }
      }
      if (typeof content !== 'string') {
        throw new SDKError(`scratchpad: '${action}' needs 'content'.`, 'LOUSHO_CONFIG_INVALID');
      }
      await mkdir(dir, { recursive: true });
      if (action === 'append') await appendFile(file, content, 'utf8');
      else await writeFile(file, content, 'utf8');
      return { wrote: name };
    },
  });
}

/** `CLAUDE.md` first; `AGENTS.md` is headed so its origin stays visible in the merged instructions. */
async function rootInstructionParts(root: string, manifest: ClaudeProjectManifest): Promise<string[]> {
  const parts: string[] = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    const text = (await readFile(p, 'utf8')).trim();
    if (!text) continue;
    parts.push(file === 'AGENTS.md' ? `## AGENTS.md\n\n${text}` : text);
    manifest.instructionFiles.push(file);
  }
  return parts;
}

/** `.claude/rules/*.md` → one `## <file>` section each, sorted by filename. */
async function ruleParts(claudeDir: string, manifest: ClaudeProjectManifest): Promise<string[]> {
  const parts: string[] = [];
  for (const { file, text } of await readMarkdownDir(path.join(claudeDir, 'rules'))) {
    const body = stripFrontmatter(text);
    if (!body) continue;
    parts.push(`## ${file}\n\n${body}`);
    manifest.rules.push(file);
  }
  return parts;
}

/** Root instruction files + `.claude/rules/*.md` sections, and the manifest entries they produce. */
async function loadInstructions(
  root: string,
  claudeDir: string,
  options: ClaudeProjectOptions,
  manifest: ClaudeProjectManifest
): Promise<string | undefined> {
  const parts = [
    ...(await rootInstructionParts(root, manifest)),
    ...(options.rules === false ? [] : await ruleParts(claudeDir, manifest)),
  ];
  return parts.length ? parts.join('\n\n') : undefined;
}

/** `.claude/skills` via the shared loader (identical layout). */
async function loadClaudeSkills(claudeDir: string, manifest: ClaudeProjectManifest): Promise<Skill[] | undefined> {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!existsSync(skillsDir)) return undefined;
  const skills = await loadSkills(skillsDir);
  manifest.skills = skills.map((s) => s.name);
  return skills;
}

/** One `.claude/agents/*.md` file to a `SimpleAgent`; a missing model source is an error naming the file. */
function buildSubagent(file: string, text: string, options: ClaudeProjectOptions): { name: string; agent: SimpleAgent } {
  const spec = parseAgentFile(path.join('.claude', 'agents', file), text);
  const model = spec.model ?? options.model;
  const provider = spec.model ? undefined : options.provider;
  if (!model && !provider) {
    throw new SDKError(
      `claudeProject: '.claude/agents/${file}' needs a model: set 'model' in its frontmatter or pass { provider } / { model } to claudeProject().`,
      'LOUSHO_CONFIG_INVALID'
    );
  }
  return {
    name: spec.name,
    agent: createAgent({
      description: spec.description,
      instructions: spec.instructions,
      ...(provider ? { provider } : { model: model! }),
    }),
  };
}

/** `.claude/agents/*.md` files to a `subagents` map (skipped when `agents: false`). */
async function loadSubagents(
  claudeDir: string,
  options: ClaudeProjectOptions,
  manifest: ClaudeProjectManifest
): Promise<Record<string, SimpleAgent> | undefined> {
  const agentFiles = options.agents === false ? [] : await readMarkdownDir(path.join(claudeDir, 'agents'));
  if (!agentFiles.length) return undefined;
  const subagents: Record<string, SimpleAgent> = {};
  for (const { file, text } of agentFiles) {
    const { name, agent } = buildSubagent(file, text, options);
    subagents[name] = agent;
    manifest.subagents.push(name);
  }
  return subagents;
}

/**
 * Loads a repository's Claude-Code-conventional context into options that
 * spread into `createAgent()`. `dir` defaults to `process.cwd()`.
 *
 * Unlike {@link loadAgentDir} this executes nothing the directory carries:
 * markdown is read as data, and `.claude/agents` sub-agents are built with
 * the caller's `provider`/`model` (or their own `model` frontmatter). A
 * sub-agent file without a resolvable provider is an error naming the file.
 */
export async function claudeProject(dir: string = process.cwd(), options: ClaudeProjectOptions = {}): Promise<ClaudeProject> {
  const root = path.resolve(dir);
  const claudeDir = path.join(root, '.claude');
  const manifest: ClaudeProjectManifest = {
    dir: root,
    instructionFiles: [],
    rules: [],
    skills: [],
    subagents: [],
    scratchpad: false,
    ignored: ['commands', 'settings.json', 'settings.local.json', 'mcp.json'].filter((f) =>
      existsSync(path.join(claudeDir, f))
    ),
  };

  const scratchpadDir = path.join(claudeDir, 'scratchpad');
  const tools = options.scratchpad === true || existsSync(scratchpadDir) ? [scratchpadTool(scratchpadDir)] : undefined;
  if (tools) manifest.scratchpad = true;

  const out: ClaudeProject = { manifest };
  const instructions = await loadInstructions(root, claudeDir, options, manifest);
  if (instructions) out.instructions = instructions;
  const skills = await loadClaudeSkills(claudeDir, manifest);
  if (skills?.length) out.skills = skills;
  const subagents = await loadSubagents(claudeDir, options, manifest);
  if (subagents) out.subagents = subagents;
  if (tools) out.tools = tools;
  return out;
}
