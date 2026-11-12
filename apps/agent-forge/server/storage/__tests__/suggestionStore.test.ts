import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRepo } from '../agentRepo';
import { SUGGESTION_ID_RE, SuggestionStore, promptHash } from '../suggestionStore';
import type { PortabilityAnalysis, PromptSuggestion } from '../../../shared/wireTypes';

const SPEC_HASH = 'sha256:0123456789abcdef0123456789abcdef';
const PORTABILITY_ID = `portability-${SPEC_HASH.slice('sha256:'.length, 'sha256:'.length + 16)}`;

const SUGGESTION: PromptSuggestion = {
  kind: 'prompt_edit',
  id: 'sug-1',
  agentId: 'ops',
  sourceTraceId: 'trace-1',
  expectedPromptHash: promptHash('Be helpful.'),
  proposedPromptHash: promptHash('Be helpful. Always cite sources.'),
  oldText: 'Be helpful.',
  newText: 'Be helpful. Always cite sources.',
  confidence: 'high',
  optimizationClass: 'Missing operational fact',
  evidence: 'Two runs retried fetch calls for the same page.',
  expectedSaving: '~800 tokens per run',
  risk: 'Citations may lengthen answers.',
  validationPlan: ['Re-run the friction trace', 'Check the answer still cites'],
  status: 'open',
  createdAt: '2026-02-03T04:05:06.000Z',
  updatedAt: '2026-02-03T04:05:06.000Z',
};

const ANALYSIS: PortabilityAnalysis = {
  kind: 'portability',
  id: PORTABILITY_ID,
  agentId: 'ops',
  specHash: SPEC_HASH,
  summary: 'One sender-specific reference found.',
  findings: [
    {
      location: 'instructions',
      kind: 'email_address',
      quote: 'email sam@example.com',
      explanation: 'Hard-coded recipient tied to the author.',
      suggestion: 'Replace with [YOUR EMAIL].',
    },
  ],
  adaptedInstructions: null,
  model: null,
  createdAt: '2026-02-03T04:05:07.000Z',
};

let NOW = new Date('2026-02-04T00:00:00.000Z');
const FIXED = () => NOW;

describe('SuggestionStore', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let store: SuggestionStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d05-suggestions-'));
    repo = new AgentRepo(baseDir);
    NOW = new Date('2026-02-04T00:00:00.000Z');
    store = new SuggestionStore(repo, FIXED);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const suggestionsDir = (id: string) => path.join(repo.sidecarDir(id), 'suggestions');
  const suggestionPath = (id: string, suggestionId: string) =>
    path.join(suggestionsDir(id), `${suggestionId}.json`);

  it('promptHash is sha256-prefixed, stable, and hashes the raw string', () => {
    expect(promptHash('a')).toBe('sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect(promptHash('a')).toBe(promptHash('a'));
    // No trimming: surrounding whitespace changes the CAS key.
    expect(promptHash('a ')).not.toBe(promptHash('a'));
    expect(promptHash('')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('save then get round-trips both record kinds', async () => {
    await store.save('ops', SUGGESTION);
    await store.save('ops', ANALYSIS);

    expect(await store.get('ops', SUGGESTION.id)).toEqual(SUGGESTION);
    expect(await store.get('ops', ANALYSIS.id)).toEqual(ANALYSIS);
    expect(JSON.parse(fs.readFileSync(suggestionPath('ops', SUGGESTION.id), 'utf8'))).toEqual(SUGGESTION);
    expect(await store.get('ops', 'missing')).toBeUndefined();
    expect(await store.get('ghost', SUGGESTION.id)).toBeUndefined();
  });

  it('list returns every record newest createdAt first', async () => {
    const older: PromptSuggestion = { ...SUGGESTION, id: 'sug-old', createdAt: '2026-02-01T00:00:00.000Z' };
    await store.save('ops', older);
    await store.save('ops', SUGGESTION);
    await store.save('ops', ANALYSIS);

    expect((await store.list('ops')).map((item) => item.id)).toEqual([ANALYSIS.id, SUGGESTION.id, older.id]);
    expect(await store.list('ghost')).toEqual([]);
  });

  it('get with a traversal id returns undefined without reading any file', async () => {
    // A valid record sitting exactly where '../x' would resolve to: if get
    // touched the filesystem it would find this.
    fs.mkdirSync(repo.sidecarDir('ops'), { recursive: true });
    fs.writeFileSync(path.join(repo.sidecarDir('ops'), 'x.json'), JSON.stringify(SUGGESTION));

    expect(await store.get('ops', '../x')).toBeUndefined();
    expect(await store.get('ops', '')).toBeUndefined();
    expect(await store.get('ops', 'a'.repeat(65))).toBeUndefined();
    expect(await store.get('ops', 'has space')).toBeUndefined();
    expect(await store.setStatus('ops', '../x', 'applied')).toBeUndefined();
  });

  it('save throws on an id failing SUGGESTION_ID_RE and writes nothing', async () => {
    await expect(store.save('ops', { ...SUGGESTION, id: '../x' })).rejects.toThrow(/Invalid suggestion id/);
    await expect(store.save('ops', { ...SUGGESTION, id: 'a/b' })).rejects.toThrow(/Invalid suggestion id/);
    expect(fs.existsSync(suggestionsDir('ops'))).toBe(false);
  });

  it('setStatus updates status + updatedAt on a prompt_edit record and returns it', async () => {
    await store.save('ops', SUGGESTION);
    NOW = new Date('2026-02-05T09:10:11.000Z');

    const updated = await store.setStatus('ops', SUGGESTION.id, 'applied');
    expect(updated).toEqual({ ...SUGGESTION, status: 'applied', updatedAt: NOW.toISOString() });
    expect(await store.get('ops', SUGGESTION.id)).toEqual(updated);
    expect(await store.setStatus('ops', 'missing', 'dismissed')).toBeUndefined();
  });

  it('setStatus on a portability record returns undefined and leaves it unchanged', async () => {
    await store.save('ops', ANALYSIS);

    expect(await store.setStatus('ops', ANALYSIS.id, 'applied')).toBeUndefined();
    expect(await store.get('ops', ANALYSIS.id)).toEqual(ANALYSIS);
    expect(JSON.parse(fs.readFileSync(suggestionPath('ops', ANALYSIS.id), 'utf8'))).toEqual(ANALYSIS);
  });

  it('findPortability hits by spec hash and misses after the hash changes', async () => {
    await store.save('ops', ANALYSIS);

    expect(await store.findPortability('ops', SPEC_HASH)).toEqual(ANALYSIS);
    // Same prefix, different tail: a spec edit yields a different cache key.
    expect(await store.findPortability('ops', `${SPEC_HASH.slice(0, -1)}0`)).toBeUndefined();
    expect(await store.findPortability('ghost', SPEC_HASH)).toBeUndefined();

    // A file at the derived name whose own specHash disagrees is a miss too.
    await store.save('ops', { ...ANALYSIS, specHash: 'sha256:ffffffffffffffffffffffffffffffff' });
    expect(await store.findPortability('ops', SPEC_HASH)).toBeUndefined();
  });

  it('unparsable suggestion files are skipped by list with a warning', async () => {
    await store.save('ops', SUGGESTION);
    fs.writeFileSync(path.join(suggestionsDir('ops'), 'broken.json'), '{not json');
    fs.writeFileSync(path.join(suggestionsDir('ops'), 'note.txt'), 'ignored - not .json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await store.list('ops')).toEqual([SUGGESTION]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('SUGGESTION_ID_RE accepts the shapes ids take', () => {
    expect(SUGGESTION_ID_RE.test('sug-1')).toBe(true);
    expect(SUGGESTION_ID_RE.test(PORTABILITY_ID)).toBe(true);
    expect(SUGGESTION_ID_RE.test('a'.repeat(64))).toBe(true);
    expect(SUGGESTION_ID_RE.test('a'.repeat(65))).toBe(false);
    expect(SUGGESTION_ID_RE.test('../x')).toBe(false);
    expect(SUGGESTION_ID_RE.test('')).toBe(false);
  });
});
