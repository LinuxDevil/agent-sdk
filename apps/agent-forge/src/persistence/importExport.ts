import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from '@loushy/build-ai-agent';
// NOTE (deviation, documented in the epic report): `agentSpecSchema` is a
// VALUE import, not `import type`, so it ends up in this browser bundle.
// The `@loushy/build-ai-agent` package only exposes one bundled entry
// point (its "." export) which eagerly imports Node-only/native deps
// (dockerode, for the sandboxed tool executor) that break a Vite/browser
// build. There's no narrower "./spec" export subpath to import just the
// schema from. Importing the zod schema directly from the SDK's source
// tree (still inside this monorepo, not a different package) avoids
// pulling in the rest of the SDK's dependency graph. AgentSpec/
// AgentSpecTrigger above stay `import type`-only from the package
// proper, which is erased at build time and has no such cost.
import { agentSpecSchema } from '../../../../src/spec/schema';

export type ExportFormat = 'yaml' | 'json';

/** Serializes an `AgentSpec` to text, in the same YAML/JSON shapes `loadSpec()` reads. */
export function serializeSpec(spec: AgentSpec, format: ExportFormat): string {
  return format === 'json' ? JSON.stringify(spec, null, 2) : stringifyYaml(spec);
}

/**
 * Parses spec text (YAML or JSON) and validates it against the SDK's own
 * `agentSpecSchema`, mirroring `loadSpec()`'s validation for a file already
 * read into memory (a browser `File` has no filesystem path for `loadSpec`
 * to use `fs.readFileSync` + extension-sniff against).
 */
export function parseSpecText(text: string, format: ExportFormat): AgentSpec {
  const data = format === 'json' ? JSON.parse(text) : parseYaml(text);
  const result = agentSpecSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `'${(issue.path ?? []).join('.') || '(root)'}': ${issue.message}`)
      .join('; ');
    throw new Error(`parseSpecText: import failed validation - ${details}`);
  }
  return result.data;
}

function formatFromFilename(filename: string): ExportFormat {
  return filename.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
}

/**
 * Triggers a browser download of `spec` as YAML or JSON, via a Blob object
 * URL (no server round-trip). `document`-dependent, so only usable in a
 * browser/jsdom environment.
 */
export function downloadSpec(spec: AgentSpec, filename: string): void {
  const format = formatFromFilename(filename);
  const text = serializeSpec(spec, format);
  const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/yaml' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Reads a `File`/`Blob`'s contents as text. Prefers the standard
 * `.text()` method (real browsers, modern Node); falls back to
 * `FileReader` for environments whose `File` polyfill doesn't implement it
 * (e.g. jsdom, used by this app's own tests) or whose `Response` mishandles
 * a `File` body.
 */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('readFileText: FileReader error'));
    reader.readAsText(file);
  });
}

/** Reads an uploaded `File` (from an `<input type="file">`) and parses/validates it as an `AgentSpec`. */
export async function importSpecFile(file: File): Promise<AgentSpec> {
  const text = await readFileText(file);
  return parseSpecText(text, formatFromFilename(file.name));
}
