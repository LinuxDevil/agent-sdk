import { describe, expect, it } from 'vitest';
import { AUTHOR_PROMPT_SECTIONS, AUTHOR_STATIC_PROMPT, buildAuthorSystemPrompt, type AuthorPromptCatalogs } from '../index';
import { renderCatalogPreamble } from '../catalogPreamble';
import { AUTHOR_TOOL_NAMES } from '../../toolNames';

/**
 * The Author's system prompt contract: byte-stable section assembly (the
 * committed snapshot is the tripwire for any prose edit), a deterministic
 * catalog preamble (sorted, order-independent, env-free), and a scan that
 * keeps every tool name the prose mentions inside AUTHOR_TOOL_NAMES.
 */
const CATALOGS: AuthorPromptCatalogs = {
  models: [
    {
      id: 'anthropic/claude-sonnet-5-5',
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true },
    },
    {
      id: 'openai/gpt-4o',
      capabilities: { tools: true, vision: true, reasoning: false, structuredOutput: true },
    },
  ],
  tools: [
    { name: 'web_fetch', description: 'Fetches a web page.', needsCredentials: [], mutating: false },
    { name: 'http_request', description: 'Makes an HTTP request.', needsCredentials: ['X_API_KEY'], mutating: true },
  ],
  guardrails: [
    { name: 'pii', description: 'Finds personal data.', on: ['input', 'output'] },
    { name: 'prompt-injection', description: 'Flags attempts to override instructions.', on: ['input'] },
  ],
  triggers: [
    { type: 'chat', description: 'Runs when the user sends a chat message.' },
    { type: 'cron', description: 'Runs on a schedule.' },
  ],
};

/** The section headings AUTHOR_STATIC_PROMPT must show, in order (PLAN 8.1's fixed assembly). */
const EXPECTED_HEADINGS = [
  '# lousho Agent Author',
  '## Working out what the user wants',
  '## Turn context from the app',
  '## Grounding every value',
  '## Building a new agent',
  '## Changing an existing agent',
  '## Patch contract',
  '## The spec you are assembling',
  '## Picking building blocks',
  "## Writing the agent's instructions",
  '## Collecting secrets',
  '## Trying a draft',
  '## Actions the user takes in the app',
  '## Capability honesty',
  '## Reply style',
  '## Rules you never break',
];

describe('AUTHOR_STATIC_PROMPT', () => {
  it('is byte-stable (edit a section and this snapshot must change on purpose)', () => {
    expect(AUTHOR_STATIC_PROMPT).toMatchSnapshot();
  });

  it('assembles the 16 sections in the contract order, joined by one blank line', () => {
    expect(AUTHOR_STATIC_PROMPT).toBe(AUTHOR_PROMPT_SECTIONS.join('\n\n'));
    const headings = AUTHOR_STATIC_PROMPT.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual(EXPECTED_HEADINGS);
  });

  it('names no tool outside AUTHOR_TOOL_NAMES', () => {
    const mentioned = AUTHOR_STATIC_PROMPT.match(/\b(list|get|propose|save|discard|set|request|run|search|probe|open)[A-Z]\w+/g) ?? [];
    const known = new Set<string>(AUTHOR_TOOL_NAMES);
    expect([...new Set(mentioned)].filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('buildAuthorSystemPrompt', () => {
  it('is the static prompt plus the catalog preamble', () => {
    expect(buildAuthorSystemPrompt(CATALOGS)).toBe(`${AUTHOR_STATIC_PROMPT}\n\n${renderCatalogPreamble(CATALOGS)}`);
  });

  it('gives identical output for catalogs given in different orders', () => {
    const shuffled: AuthorPromptCatalogs = {
      models: [...CATALOGS.models].reverse(),
      tools: [...CATALOGS.tools].reverse(),
      guardrails: [...CATALOGS.guardrails].reverse(),
      triggers: [...CATALOGS.triggers].reverse(),
    };
    expect(buildAuthorSystemPrompt(shuffled)).toBe(buildAuthorSystemPrompt(CATALOGS));
  });
});

describe('renderCatalogPreamble', () => {
  it('renders each list sorted with the contract formatting', () => {
    expect(renderCatalogPreamble(CATALOGS)).toMatchInlineSnapshot(`
      "# Preloaded catalogs
      These lists were current when Studio started. Use the list tools for details or when something is missing.

      ## Models
      - anthropic/claude-sonnet-5-5 (tools, vision, reasoning, structured output)
      - openai/gpt-4o (tools, vision, structured output)

      ## Builtin tools
      - http_request: Makes an HTTP request. [needs: X_API_KEY] [acts outside the machine]
      - web_fetch: Fetches a web page.

      ## Guardrails
      - pii (input, output): Finds personal data.
      - prompt-injection (input): Flags attempts to override instructions.

      ## Trigger types
      - chat: Runs when the user sends a chat message.
      - cron: Runs on a schedule."
    `);
  });

  it('renders (none) when a model reports no capabilities', () => {
    const prompt = renderCatalogPreamble({
      ...CATALOGS,
      models: [{ id: 'local/echo', capabilities: { tools: false, vision: false, reasoning: false, structuredOutput: false } }],
    });
    expect(prompt).toContain('- local/echo (none)');
  });
});
