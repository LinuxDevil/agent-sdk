import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentSpecV2 } from '@linuxdevil/lousho/spec';
// `@linuxdevil/lousho/spec` is the SDK's browser-safe spec entry (schema, types and
// pure helpers only, no Node-only deps), so this value import is safe in
// the Vite/browser bundle where the package root is not.
import { agentSpecV2Schema } from '@linuxdevil/lousho/spec';

export type ExportFormat = 'yaml' | 'json';

/** Serializes an `AgentSpecV2` to text, in the same YAML/JSON shapes `loadSpecV2()` reads. */
export function serializeSpec(spec: AgentSpecV2, format: ExportFormat): string {
  return format === 'json' ? JSON.stringify(spec, null, 2) : stringifyYaml(spec);
}

/**
 * Parses spec text (YAML or JSON) and validates it against the SDK's own
 * `agentSpecV2Schema`, mirroring `loadSpecV2()`'s validation for a file already
 * read into memory (a browser `File` has no filesystem path for `loadSpecV2`
 * to use `fs.readFileSync` + extension-sniff against).
 */
export function parseSpecText(text: string, format: ExportFormat): AgentSpecV2 {
  const data = format === 'json' ? JSON.parse(text) : parseYaml(text);
  const result = agentSpecV2Schema.safeParse(data);
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
 * Triggers a browser download of `text` as `filename` with MIME `type`, via
 * a Blob object URL (no server round-trip). `document`-dependent, so only
 * usable in a browser/jsdom environment. Shared by {@link downloadSpec}
 * and the Code tab's Download buttons (A08).
 */
export function downloadText(text: string, filename: string, type: string): void {
  downloadBlob(new Blob([text], { type }), filename);
}

/**
 * Triggers a browser download of an already-built `Blob` (the export
 * routes' YAML/bundle responses, L07) via a temporary `<a download>` +
 * object URL - the same mechanism {@link downloadText} uses.
 */
export function downloadBlob(blob: Blob, filename: string): void {
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
 * Triggers a browser download of `spec` as YAML or JSON (the format follows
 * the filename's extension), via a Blob object URL (no server round-trip).
 * `document`-dependent, so only usable in a browser/jsdom environment.
 */
export function downloadSpec(spec: AgentSpecV2, filename: string): void {
  const format = formatFromFilename(filename);
  const text = serializeSpec(spec, format);
  downloadText(text, filename, format === 'json' ? 'application/json' : 'text/yaml');
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

/** Reads an uploaded `File` (from an `<input type="file">`) and parses/validates it as an `AgentSpecV2`. */
export async function importSpecFile(file: File): Promise<AgentSpecV2> {
  const text = await readFileText(file);
  return parseSpecText(text, formatFromFilename(file.name));
}
