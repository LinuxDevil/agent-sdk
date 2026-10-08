// Repro: send a real PDF invoice as a `file` part to LM Studio (OpenAI-compatible), three ways.
import { readFileSync } from 'node:fs';
import { createAgent, OpenAIProvider, fromAiSdk } from '@lousho/build-ai-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { startProxy, summarize } from './proxy.js';
import { LOCAL_MODEL } from '../../_shared/local.js';

const pdf = new Uint8Array(readFileSync(new URL('../fixtures/inv-16-summit-pdf.pdf', import.meta.url)));
const proxy = await startProxy(1241, { keepResponses: true });
const out = z.object({ invoiceNumber: z.string().nullable(), total: z.string().nullable(), couldRead: z.boolean() });
const parts = [
  { type: 'text' as const, text: 'Extract the invoice number and total from the attached PDF. If you cannot see any attached document content, set couldRead=false and the other fields null.' },
  { type: 'file' as const, data: pdf, mimeType: 'application/pdf', filename: 'inv-16-summit-pdf.pdf' },
];

async function attempt(label: string, provider: any) {
  const before = proxy.log.length;
  const t0 = Date.now();
  try {
    const r = await createAgent({ provider, output: out, instructions: 'You read invoices.' }).send(parts);
    console.log(`\n[${label}] ${Date.now() - t0}ms finish=${r.finishReason} object=${JSON.stringify(r.object)} outputError=${JSON.stringify(r.outputError)}`);
  } catch (e: any) {
    console.log(`\n[${label}] THREW ${e?.constructor?.name} code=${e?.code} status=${e?.statusCode ?? e?.status}: ${String(e?.message).slice(0, 500)}`);
  }
  for (const e of proxy.log.slice(before)) {
    const b = e.body;
    const userContent = (b.input ?? b.messages)?.find((m: any) => m.role === 'user')?.content;
    const shape = Array.isArray(userContent) ? userContent.map((p: any) => ({ type: p.type, keys: Object.keys(p), filename: p.filename ?? p.file?.filename, dataPrefix: String(p.file_data ?? p.file?.file_data ?? p.text ?? '').slice(0, 60) })) : userContent;
    console.log('  wire', e.path, e.status, JSON.stringify(shape));
    if (e.status !== 200) console.log('  resp', e.responseText?.slice(0, 400));
  }
}

// 1) built-in OpenAIProvider (Responses API; application/pdf is a "sendable" file type on ai 7)
await attempt('OpenAIProvider /responses', new OpenAIProvider({ apiKey: 'lm-studio', baseURL: proxy.url, defaultModel: LOCAL_MODEL, maxRetries: 0 }));
// 2) fromAiSdk over the Chat Completions model, opting PDFs in
const oa = createOpenAI({ apiKey: 'lm-studio', baseURL: proxy.url });
await attempt('fromAiSdk(openai.chat) pdf opted-in', fromAiSdk(oa.chat(LOCAL_MODEL), { fileMediaTypes: ['application/pdf'] }));
// 3) fromAiSdk without opting in -> text note
await attempt('fromAiSdk(openai.chat) default', fromAiSdk(oa.chat(LOCAL_MODEL)));
proxy.close();
