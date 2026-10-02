/**
 * Live test for `web_fetch` (N13a): a real model (gpt-4o-mini on OpenRouter)
 * calls the tool against https://example.com.
 *
 * - Replay (default): the model is served from the cassette and the tool gets
 *   the saved copy of the page through its test-only `transport`, so the test
 *   touches neither the network nor the model and costs nothing. The second
 *   model request carries the tool's output, so replay also fails (cassette
 *   mismatch) if the saved page no longer converts to what was recorded.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set. The tool fetches
 *   the real page through its pinned connection; the page is saved next to
 *   the cassette for replay.
 *
 * Skipped when the cassette is missing and no key is set.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAgent } from '../../createAgent';
import '../../providers'; // registers the real providers (openrouter)
import { resolveProvider } from '../../providers/resolveProvider';
import { recordReplay } from '../../testing';
import { createWebFetchTool } from './webFetch';

const CASSETTE = path.join(__dirname, '__cassettes__', 'web-fetch.json');
const PAGE = path.join(__dirname, '__cassettes__', 'web-fetch.example-com.json');
const URL_TO_FETCH = 'https://example.com';
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(CASSETTE) && fs.existsSync(PAGE);

interface SavedPage {
  status: number;
  contentType: string | null;
  body: string;
}

/** Record mode: save the page the tool is about to read, so replay can serve the same bytes. */
async function savePage(): Promise<SavedPage> {
  const response = await fetch(URL_TO_FETCH);
  const page = { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
  fs.mkdirSync(path.dirname(PAGE), { recursive: true });
  fs.writeFileSync(PAGE, JSON.stringify(page, null, 2) + '\n');
  return page;
}

describe('web_fetch (live, recorded)', () => {
  it.skipIf(!runnable)('the model fetches example.com and reads its heading', async () => {
    const saved = recording ? await savePage() : (JSON.parse(fs.readFileSync(PAGE, 'utf-8')) as SavedPage);
    const tool = recording
      ? createWebFetchTool()
      : createWebFetchTool({
          transport: async () =>
            new Response(saved.body, { status: saved.status, headers: saved.contentType ? { 'content-type': saved.contentType } : {} }),
        });
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), {
      cassette: CASSETTE,
      mode: recording ? 'record' : 'replay',
    });
    const agent = createAgent({ provider, tools: [tool], maxSteps: 3 });

    const result = await agent.send("Fetch https://example.com and tell me the page's heading in a few words.");

    const call = result.toolCalls.find((c) => c.function.name === 'web_fetch');
    expect(call).toBeDefined();
    expect(JSON.parse(call!.function.arguments).url).toMatch(/^https:\/\/example\.com\/?$/);
    expect(result.text).toMatch(/Example Domain/i);
  }, 60_000);
});
