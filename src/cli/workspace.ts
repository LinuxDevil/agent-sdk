import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exitCodeFor, parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { cliHost } from './workspaceHostCli';
import { describeEvent, remoteList, remoteRun, remoteShow, remoteValidate, type RemoteOutput } from './workspaceRemote';
import { WORKSPACE_TEMPLATES, workspaceTemplateFiles, type WorkspaceTemplate } from './workspaceTemplates';
import { createFetchClient, type ApiClient } from '../workspaces/client/apiClient';
import { validateWorkspace } from '../workspaces/contracts/validate';
import type { PageResult } from '../workspaces/contracts/execution';
import { loadWorkspace } from '../workspaces/runtime/loadWorkspace';
import { createWorkspaceRuntime } from '../workspaces/runtime/workspaceRuntime';
import { folderSource } from '../workspaces/source/folderSource';
import { readSourceTree } from '../workspaces/source/tree';
import type { WorkspaceSource } from '../workspaces/source/types';
import type { ProviderResolver } from '../workspaces/runtime/workspaceHost';

interface Writer {
  write(text: string): unknown;
}

export interface WorkspaceIo {
  stdout: Writer;
  stderr: Writer;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  providers?: ProviderResolver;
  client?: ApiClient;
  cwd?: string;
}

type Values = Record<string, unknown>;

const SUBCOMMANDS = ['init', 'ls', 'show', 'validate', 'run'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const USAGE: Record<Subcommand, string> = {
  init: 'Usage: lousho workspace init [dir] [--template marketing|coding|blank] [--name <name>] [--json]',
  ls: 'Usage: lousho workspace ls [--source <dir> | --service <url> [--workspace <id>]] [--json]',
  show: 'Usage: lousho workspace show [--source <dir> | --service <url> --workspace <id>] [--page <id>] [--json]',
  validate: 'Usage: lousho workspace validate [--source <dir> | --service <url> --workspace <id>] [--strict] [--json]',
  run: 'Usage: lousho workspace run [message] [--source <dir> | --service <url> --workspace <id>] [--page <id>] [--inputs file.json] [--model provider/model] [--host module] [--project dir] [--json]',
};

const HELP = `lousho workspace - work with a workspace folder or a running workspace service.

${Object.values(USAGE).join('\n')}

--source <dir> is the default (the current directory); --service <url> drives a running service instead (--token or LOUSHO_TOKEN authenticates).
Exit codes: 0 success, 1 failure or an invalid workspace, 2 usage error.`;

const SOURCE_OPTIONS = {
  source: { type: 'string' },
  service: { type: 'string' },
  workspace: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'boolean' },
} as const;

const SPECS: Record<Subcommand, CommandSpec> = {
  init: { command: 'workspace init', usage: USAGE.init, options: { template: { type: 'string' }, name: { type: 'string' }, json: { type: 'boolean' } }, positionals: 1 },
  ls: { command: 'workspace ls', usage: USAGE.ls, options: SOURCE_OPTIONS },
  show: { command: 'workspace show', usage: USAGE.show, options: { ...SOURCE_OPTIONS, page: { type: 'string' } } },
  validate: { command: 'workspace validate', usage: USAGE.validate, options: { ...SOURCE_OPTIONS, strict: { type: 'boolean' } } },
  run: {
    command: 'workspace run',
    usage: USAGE.run,
    options: { ...SOURCE_OPTIONS, page: { type: 'string' }, inputs: { type: 'string' }, model: { type: 'string' }, host: { type: 'string' }, project: { type: 'string' } },
    positionals: 1,
  },
};

/** Whether `name` is a `lousho workspace` subcommand. */
export function isWorkspaceCommand(name: string | undefined): boolean {
  return SUBCOMMANDS.some((known) => known === name);
}

const str = (value: unknown): string | undefined => stringValue(value as string | undefined);

function outputOf(io: WorkspaceIo): RemoteOutput {
  return {
    line: (text) => io.stdout.write(`${text}\n`),
    json: (value) => io.stdout.write(`${JSON.stringify(value)}\n`),
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

function titleOf(id: string): string {
  return id.replace(/-/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

function pageInfo(tree: Readonly<Record<string, unknown>>, id: string): { name: string; type: string } {
  const raw = tree[`pages/${id}/page.json`];
  try {
    const page = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { name?: string; execution?: { type?: string } };
    return { name: page.name ?? id, type: page.execution?.type ?? '?' };
  } catch {
    return { name: id, type: '?' };
  }
}

function problemLine(item: { severity: string; code: string; file: string; path: string; message: string }): string {
  return `${item.severity}\t${item.code}\t${item.file}${item.path === '' ? '' : `#${item.path}`}\t${item.message}`;
}

function templateOf(value: string | undefined, spec: CommandSpec): WorkspaceTemplate {
  const found = WORKSPACE_TEMPLATES.find((template) => template === (value ?? 'blank'));
  if (!found) throw usageError(spec, `--template must be one of ${WORKSPACE_TEMPLATES.join(', ')}.`);
  return found;
}

function runInit(values: Values, positionals: string[], io: WorkspaceIo, spec: CommandSpec): number {
  const dir = path.resolve(io.cwd ?? process.cwd(), positionals[0] ?? '.');
  const name = str(values.name) ?? titleOf(path.basename(dir));
  const files = workspaceTemplateFiles(templateOf(str(values.template), spec), slug(path.basename(dir)), name);
  const existing = Object.keys(files).filter((file) => fs.existsSync(path.join(dir, file)));
  if (existing.length > 0) throw new Error(`lousho workspace init: ${dir} already has ${existing.join(', ')}; nothing was written.`);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const out = outputOf(io);
  if (values.json === true) out.json({ dir, files: Object.keys(files).sort() });
  else {
    out.line(`Created ${Object.keys(files).length} files in ${dir}.`);
    out.line(`Next: lousho workspace validate --source ${dir}`);
  }
  return 0;
}

async function runLs(dir: string, asJson: boolean, io: WorkspaceIo): Promise<number> {
  const loaded = await loadWorkspace(folderSource(dir), { mode: 'default' });
  const pages = Object.keys(loaded.manifest.pages).map((id) => ({ id, ...pageInfo(loaded.tree, id) }));
  const out = outputOf(io);
  if (asJson) out.json(pages);
  else for (const page of pages) out.line(`${page.id}\t${page.name}\t${page.type}`);
  return 0;
}

async function runShow(dir: string, page: string | undefined, asJson: boolean, io: WorkspaceIo): Promise<number> {
  const out = outputOf(io);
  if (page !== undefined) {
    const runtime = createWorkspaceRuntime(folderSource(dir), await cliHost(dir));
    try {
      const explained = await runtime.explain(page);
      if (asJson) out.json(explained);
      else out.line(explained.text);
    } finally {
      await runtime.close();
    }
    return 0;
  }
  const loaded = await loadWorkspace(folderSource(dir), { mode: 'default' });
  if (asJson) {
    out.json({ revision: loaded.revision, manifest: loaded.manifest, problems: loaded.problems });
    return 0;
  }
  out.line(`${loaded.manifest.id} ${loaded.manifest.name} at ${loaded.revision}`);
  for (const [id, view] of Object.entries(loaded.manifest.pages)) {
    out.line(`  ${id}\t${pageInfo(loaded.tree, id).type}\t${view.attachments.length} agents\t${view.files.length} files`);
  }
  return 0;
}

async function runValidate(dir: string, strict: boolean, asJson: boolean, io: WorkspaceIo): Promise<number> {
  const { tree } = await readSourceTree(folderSource(dir));
  const problems = validateWorkspace(tree, { mode: strict ? 'strict' : 'default' });
  const out = outputOf(io);
  if (asJson) out.json(problems);
  else if (problems.length === 0) out.line('The workspace is valid.');
  else for (const item of problems) out.line(problemLine(item));
  return problems.some((item) => item.severity === 'error') ? 1 : 0;
}

function readInputs(file: string | undefined, cwd: string): unknown {
  if (file === undefined) return undefined;
  return JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
}

function printResult(result: PageResult, asJson: boolean, io: WorkspaceIo): number {
  const out = outputOf(io);
  if (asJson) out.json(result);
  else {
    out.line(`status: ${result.status}`);
    if (result.error) out.line(`error: ${result.error.kind}: ${result.error.message}`);
    if (result.output !== undefined) out.line(JSON.stringify(result.output, null, 2));
    if (result.summary) out.line(result.summary);
    for (const artifact of result.artifacts) out.line(`artifact: ${artifact.name}`);
  }
  return result.status === 'ok' ? 0 : 1;
}

function withModel(source: WorkspaceSource, model: string | undefined): WorkspaceSource {
  if (model === undefined) return source;
  return {
    ...source,
    read: async (file, options) => {
      const text = await source.read(file, options);
      if (file !== 'workspace.json' || text === undefined) return text;
      const manifest = JSON.parse(text) as { defaults?: Record<string, unknown> };
      return JSON.stringify({ ...manifest, defaults: { ...manifest.defaults, model } });
    },
  };
}

async function runLocalRun(dir: string, values: Values, message: string | undefined, io: WorkspaceIo): Promise<number> {
  const asJson = values.json === true;
  const page = str(values.page);
  const host = await cliHost(dir, { providers: io.providers, project: str(values.project), hostModule: str(values.host) });
  const runtime = createWorkspaceRuntime(withModel(folderSource(dir), str(values.model)), host);
  const out = outputOf(io);
  try {
    if (page !== undefined) {
      const inputs = readInputs(str(values.inputs), io.cwd ?? process.cwd());
      const result = await runtime.runPage(
        page,
        { task: message ?? `Run the ${page} page.`, inputs },
        { onEvent: (wire) => (asJson ? undefined : io.stderr.write(`${describeEvent(wire)}\n`)) }
      );
      return printResult(result, asJson, io);
    }
    if (message === undefined) throw usageError(SPECS.run, 'a message or --page is required.');
    let code = 1;
    for await (const event of runtime.run(message, { threadId: randomUUID() })) {
      if (asJson) out.json(event);
      else if (event.type === 'page') io.stderr.write(`${describeEvent(event)}\n`);
      if (event.type !== 'finished') continue;
      code = event.status === 'ok' ? 0 : 1;
      if (asJson) continue;
      const turn = event.turn;
      if (turn.kind === 'main') out.line(turn.text);
      else if (turn.kind === 'page') out.line(turn.record.result.summary);
      else out.line(`error: ${turn.error.message}`);
    }
    return code;
  } finally {
    await runtime.close();
  }
}

function clientOf(values: Values, io: WorkspaceIo): ApiClient {
  if (io.client) return io.client;
  const token = str(values.token) ?? process.env.LOUSHO_TOKEN;
  return createFetchClient({ baseUrl: str(values.service) ?? '', ...(token && { headers: { authorization: `Bearer ${token}` } }) });
}

async function runRemote(sub: Subcommand, values: Values, message: string | undefined, io: WorkspaceIo, spec: CommandSpec): Promise<number> {
  const client = clientOf(values, io);
  const out = outputOf(io);
  const asJson = values.json === true;
  const workspace = str(values.workspace);
  if (sub === 'ls') return remoteList(client, workspace, out, asJson);
  if (workspace === undefined) throw usageError(spec, '--workspace <id> is required with --service.');
  const page = str(values.page);
  if (sub === 'show') return remoteShow(client, workspace, page, out, asJson);
  if (sub === 'validate') return remoteValidate(client, workspace, out, asJson);
  const text = message ?? (page === undefined ? undefined : `Run the ${page} page.`);
  if (text === undefined) throw usageError(spec, 'a message or --page is required.');
  const inputs = readInputs(str(values.inputs), io.cwd ?? process.cwd());
  return remoteRun(client, { workspace, message: text, ...(page !== undefined && { page }), inputs }, out, asJson);
}

async function dispatch(sub: Subcommand, args: string[], io: WorkspaceIo): Promise<number> {
  const spec = SPECS[sub];
  const { values, positionals, help } = parseCommand(spec, args);
  if (help) {
    io.stdout.write(`${spec.usage}\n`);
    return 0;
  }
  if (sub === 'init') return runInit(values, positionals, io, spec);
  const service = str(values.service);
  const source = str(values.source);
  if (service !== undefined && source !== undefined) throw usageError(spec, 'use --source or --service, not both.');
  if (service !== undefined) return runRemote(sub, values, positionals[0], io, spec);
  const dir = path.resolve(io.cwd ?? process.cwd(), source ?? '.');
  const asJson = values.json === true;
  if (sub === 'ls') return runLs(dir, asJson, io);
  if (sub === 'show') return runShow(dir, str(values.page), asJson, io);
  if (sub === 'validate') return runValidate(dir, values.strict === true, asJson, io);
  return runLocalRun(dir, values, positionals[0], io);
}

/** Runs `lousho workspace` with the arguments after `workspace` and returns the exit code. */
export async function runWorkspace(args: string[], io: WorkspaceIo = { stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY }): Promise<number> {
  const [first, ...rest] = args;
  if (first === '--help' || first === '-h') {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!isWorkspaceCommand(first)) {
    io.stderr.write(`lousho workspace: ${first === undefined ? 'a subcommand is required' : `unknown subcommand '${first}'`}.\n${HELP}\n`);
    return 2;
  }
  try {
    return await dispatch(first as Subcommand, rest, io);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return exitCodeFor(error);
  }
}
