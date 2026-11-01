/**
 * The `# Preloaded catalogs` block that ends the Author's system prompt.
 * It is rendered once at server start from the SDK catalogs (the same
 * functions `GET /catalog/*` serves), projected onto
 * {@link AuthorPromptCatalogs} first so nothing env-dependent - a model's
 * `available` flag, a stored key - can leak into the byte-stable prompt.
 * Pure: every list is sorted inside, so input order never changes the
 * output.
 */

/** The catalog slices the Author prompt renders; already projected free of env-dependent fields. */
export interface AuthorPromptCatalogs {
  models: Array<{
    id: string;
    capabilities: { tools: boolean; vision: boolean; reasoning: boolean; structuredOutput: boolean };
  }>;
  tools: Array<{ name: string; description: string; needsCredentials: string[]; mutating: boolean }>;
  guardrails: Array<{ name: string; description: string; on: string[] }>;
  triggers: Array<{ type: string; description: string }>;
}

/** Code-unit string compare: byte-stable sorting that never depends on the host locale. */
function byString<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  };
}

/** The capability words in their fixed order; '(none)' when none are true. */
function capabilityWords(capabilities: AuthorPromptCatalogs['models'][number]['capabilities']): string {
  const words: string[] = [];
  if (capabilities.tools) words.push('tools');
  if (capabilities.vision) words.push('vision');
  if (capabilities.reasoning) words.push('reasoning');
  if (capabilities.structuredOutput) words.push('structured output');
  return words.length === 0 ? 'none' : words.join(', ');
}

/** `- name: description` plus `[needs: …]` when credentialed and `[acts outside the machine]` when mutating. */
function toolLine(tool: AuthorPromptCatalogs['tools'][number]): string {
  let line = `- ${tool.name}: ${tool.description}`;
  if (tool.needsCredentials.length > 0) line += ` [needs: ${tool.needsCredentials.join(', ')}]`;
  if (tool.mutating) line += ' [acts outside the machine]';
  return line;
}

/** A section heading plus its sorted item lines ('- id (capabilities)', '- name: description', …). */
function listSection(heading: string, lines: string[]): string[] {
  return [heading, ...lines, ''];
}

/**
 * Renders the deterministic catalog block. Every list is sorted by
 * name/id/type; capability words follow the fixed order tools, vision,
 * reasoning, structured output ('(none)' when a model reports none).
 */
export function renderCatalogPreamble(catalogs: AuthorPromptCatalogs): string {
  const lines: string[] = [
    '# Preloaded catalogs',
    'These lists were current when Studio started. Use the list tools for details or when something is missing.',
    '',
  ];
  lines.push(
    ...listSection(
      '## Models',
      [...catalogs.models].sort(byString((m) => m.id)).map((m) => `- ${m.id} (${capabilityWords(m.capabilities)})`)
    )
  );
  lines.push(...listSection('## Builtin tools', [...catalogs.tools].sort(byString((t) => t.name)).map(toolLine)));
  lines.push(
    ...listSection(
      '## Guardrails',
      [...catalogs.guardrails]
        .sort(byString((g) => g.name))
        .map((g) => `- ${g.name} (${g.on.length === 0 ? 'none' : g.on.join(', ')}): ${g.description}`)
    )
  );
  lines.push(
    '## Trigger types',
    ...[...catalogs.triggers].sort(byString((t) => t.type)).map((t) => `- ${t.type}: ${t.description}`)
  );
  return lines.join('\n');
}
