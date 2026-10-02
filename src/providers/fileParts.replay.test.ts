/**
 * CI replay of the M1 live recording (`__fixtures__/cassettes/file-parts-openrouter.json`, gpt-4o-mini via OpenRouter on
 * `ai` 7): a PDF and a PNG reach the model as file parts and are read. The replay matches the requests, including a hash
 * of each attachment, so it fails if the SDK stops sending the bytes. No key, no network. Re-record with
 * `npm run test:live -- src/providers/filePartsOpenRouter` after `npm install --no-save ai@7 @ai-sdk/openai@4`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { recordReplay } from '../testing';
import { PDF_CODE, redPng, tinyPdf } from './filePartsFixtures';

const CASSETTE = join(__dirname, '__fixtures__', 'cassettes', 'file-parts-openrouter.json');

describe('file parts through OpenRouter, replayed from a real recording (M1)', () => {
  it('reads a PDF and an image', async () => {
    const provider = recordReplay(undefined, { cassette: CASSETTE, mode: 'replay' });
    const agent = createAgent({ provider, model: 'openai/gpt-4o-mini', maxSteps: 1 });

    const pdf = await agent.send([
      { type: 'text', text: 'Reply with the code word in the document only.' },
      { type: 'file', data: tinyPdf(), mimeType: 'application/pdf', filename: 'code.pdf' },
    ]);
    expect(pdf.text).toContain(PDF_CODE);

    const png = await agent.send([
      { type: 'text', text: 'Reply with the colour only.' },
      { type: 'image', image: redPng(), mimeType: 'image/png' },
    ]);
    expect(png.text.toLowerCase()).toContain('red');
  });
});
