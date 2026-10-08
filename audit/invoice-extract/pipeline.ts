/**
 * The AP pipeline: providers (retry + fallback), the extraction agent
 * (structured output), the payments agent (approvals), the flow tools and the
 * fixed 3-step flow extract -> validate -> route.
 */
import { readFileSync } from 'node:fs';
import {
  createAgent,
  defineTool,
  fromAiSdk,
  OpenAIProvider,
  withFallback,
  withRetry,
  isRetryableProviderError,
  type ExecutionResult,
  type LLMProvider,
} from '@lousho/build-ai-agent';
import { ToolRegistry } from '@lousho/build-ai-agent/tools';
import { FlowBuilder, type EditorStep } from '@lousho/build-ai-agent/flows';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { LOCAL_BASE_URL, LOCAL_MODEL } from '../_shared/local.js';
import { Extraction, type ExtractionT } from './schema.js';
import { validateInvoice, type Validation } from './validate.js';

// ---------------------------------------------------------------- providers

export interface ProviderEvents {
  retries: Array<{ attempt: number; delayMs: number; error: string }>;
  fallbacks: Array<{ from: string; to: string; error: string }>;
}
export const providerEvents: ProviderEvents = { retries: [], fallbacks: [] };

/**
 * Primary: the built-in OpenAIProvider (Responses API) on LM Studio, with the
 * ai SDK's own retries off so withRetry is the only retry layer.
 * Fallback: the same server over Chat Completions via fromAiSdk().
 */
export function makeProvider(): LLMProvider {
  const primary = new OpenAIProvider({ apiKey: 'lm-studio', baseURL: LOCAL_BASE_URL, defaultModel: LOCAL_MODEL, maxRetries: 0 });
  const chat = fromAiSdk(createOpenAI({ apiKey: 'lm-studio', baseURL: LOCAL_BASE_URL }).chat(LOCAL_MODEL));
  const retry = {
    maxRetries: 6,
    backoff: { initialMs: 3000, maxMs: 20000 },
    // LM Studio answers "Context size has been exceeded" while other clients hold the shared KV cache:
    // a 500 on /v1/responses (retried by default) but a 400 on /v1/chat/completions (not retried by default).
    retryOn: (error: unknown) => isRetryableProviderError(error) || /context size has been exceeded/i.test(errorText(error)),
    onRetry: ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: unknown }) =>
      providerEvents.retries.push({ attempt, delayMs, error: errorText(error).slice(0, 160) }),
  };
  return withFallback([withRetry(primary, retry), withRetry(chat, retry)], {
    onFallback: ({ from, to, error }: { from: string; to: string; error: unknown }) =>
      providerEvents.fallbacks.push({ from, to, error: errorText(error).slice(0, 200) }),
  });
}

/** Message plus any response body the error (or its cause chain) carries. */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e: any = error, i = 0; e && i < 4; e = e.cause, i++) {
    parts.push(String(e.message ?? ''), String(e.responseBody ?? ''), typeof e.detail === 'string' ? e.detail : '');
  }
  return parts.filter(Boolean).join(' | ');
}

// ---------------------------------------------------------------- documents

export interface Doc {
  id: string;
  path: string;
  kind: 'text' | 'pdf';
}

/** Per-document state shared by the flow tools (flows cannot pass objects between toolCall steps). */
export interface DocState {
  doc: Doc;
  signal: AbortSignal;
  extraction?: ExtractionT;
  extractionResult?: ExecutionResult & { object?: ExtractionT };
  extractionAttempts: string[];
  validation?: Validation;
  route?: 'auto' | 'approval' | 'rejected' | 'failed';
  payment?: { finishReason: string; approvalId?: string; text?: string };
  usages: Array<ExecutionResult['usage']>;
  timings: Record<string, number>;
}
export const state = new Map<string, DocState>();

/** Poor man's PDF text extraction for our uncompressed fixture: the `(..) Tj` strings. */
export function pdfToText(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString('latin1');
  return [...s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((m) => m[1].replace(/\\([\\()])/g, '$1')).join('\n');
}

// ---------------------------------------------------------------- agents

export const EXTRACT_INSTRUCTIONS = `You are an accounts-payable data-entry clerk. Extract the document the user gives you.
Rules:
- If the document is not a payable invoice (a quote, purchase order, letter, statement, receipt already paid), return kind "not_invoice".
- Normalize every date to YYYY-MM-DD. Read DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY as day-first for European, Middle-Eastern and UK documents; MM/DD/YYYY for US documents.
- Money: decimal strings with a dot, no thousands separators, no symbols ("1.234,50 EUR" -> "1234.50", "1 000,00" -> "1000.00").
- Copy the printed numbers exactly, even if they look wrong. Never fix the vendor's arithmetic.
- OCR damage: read O/0, l/1, rn/m sensibly ("l28.5O" -> "128.50", "Denrnark" -> "Denmark").
- vendor.name is the issuing company (in Latin script if the document gives one).
- taxAmount "0.00" when no tax is charged.`;

export function makeExtractor(provider: LLMProvider) {
  return createAgent({ provider, name: 'extractor', instructions: EXTRACT_INSTRUCTIONS, output: Extraction, maxSteps: 3 });
}

export function makePayments(provider: LLMProvider) {
  const schedulePayment = defineTool({
    name: 'schedule_payment',
    description: 'Schedule payment of a validated invoice by its document id.',
    input: z.object({ docId: z.string().describe('The document id, e.g. inv-01-acme-us') }),
    // The approval rule reads OUR validated numbers, never the model's arguments.
    needsApproval: ({ docId }) => {
      const v = state.get(docId)?.validation;
      return !v || v.amountUsd >= 1000 || v.flagCount > 0;
    },
    execute: async ({ docId }) => {
      const s = state.get(docId);
      if (!s?.validation) return { error: `unknown document ${docId}` };
      return { scheduled: true, docId, amountUsd: s.validation.amountUsd };
    },
  });
  return createAgent({
    provider,
    name: 'payments',
    instructions: 'You schedule invoice payments. Call schedule_payment exactly once with the docId you are given, then reply with one short sentence.',
    tools: [schedulePayment],
    maxSteps: 4,
  });
}

// ---------------------------------------------------------------- flow tools

export function makeTools(extractor: ReturnType<typeof makeExtractor>, payments: ReturnType<typeof makePayments>) {
  const reg = new ToolRegistry();

  reg.register(
    defineTool({
      name: 'extract_invoice',
      description: 'Extract one document to the Extraction schema',
      input: z.object({ docId: z.string() }),
      execute: async ({ docId }) => {
        const s = state.get(docId)!;
        const t0 = Date.now();
        const send = async (input: Parameters<typeof extractor.send>[0], label: string) => {
          s.extractionAttempts.push(label);
          const r = await extractor.send(input, { signal: s.signal });
          s.usages.push(r.usage);
          s.extractionResult = r;
          return r;
        };
        let r;
        if (s.doc.kind === 'pdf') {
          const bytes = new Uint8Array(readFileSync(s.doc.path));
          try {
            r = await send(
              [
                { type: 'text', text: `Document id ${docId} (attached PDF).` },
                { type: 'file', data: bytes, mimeType: 'application/pdf', filename: `${docId}.pdf` },
              ],
              'pdf-file-part'
            );
          } catch (e) {
            s.extractionAttempts.push(`pdf-file-part threw: ${(e as Error).message.slice(0, 120)}`);
          }
          // The file part is unusable on this server (see FINDINGS): fall back to local text extraction.
          if (!r?.object || r.object.document.kind !== 'invoice') {
            r = await send(`Document id ${docId} (text extracted from PDF):\n\n${pdfToText(bytes)}`, 'pdf-text');
          }
        } else {
          r = await send(`Document id ${docId}:\n\n${readFileSync(s.doc.path, 'utf8')}`, 'text');
        }
        s.timings.extractMs = Date.now() - t0;
        // TS check: result.object is z.output<typeof Extraction> | undefined - no cast needed.
        const obj: ExtractionT | undefined = r.object;
        if (!obj) {
          throw new Error(`extraction failed for ${docId}: ${r.finishReason} ${r.outputError?.message ?? ''}`);
        }
        s.extraction = obj;
        return { kind: obj.document.kind };
      },
    })
  );

  reg.register(
    defineTool({
      name: 'validate_invoice',
      description: 'Check business rules',
      input: z.object({ docId: z.string() }),
      execute: async ({ docId }) => {
        const s = state.get(docId)!;
        const d = s.extraction!.document;
        s.validation =
          d.kind === 'invoice'
            ? validateInvoice(d)
            : { kind: 'not_invoice', amountUsd: 0, flags: [], flagCount: 0, details: [`${d.documentType}: ${d.reason}`] };
        return s.validation; // a plain object; the flow's oneOf reads validation.amountUsd / validation.flagCount
      },
    })
  );

  reg.register(
    defineTool({
      name: 'route_invoice',
      description: 'Route a validated invoice to payment',
      input: z.object({ docId: z.string(), lane: z.enum(['auto', 'approval', 'rejected']) }),
      execute: async ({ docId, lane }) => {
        const s = state.get(docId)!;
        s.route = lane;
        if (lane === 'rejected') return { lane };
        if (lane === 'auto') {
          // Under the threshold and clean: schedule directly, no model call, no approval.
          s.payment = { finishReason: 'auto-scheduled' };
          return { lane, scheduled: true };
        }
        const t0 = Date.now();
        const r = await payments.send(`Schedule payment for document ${docId}.`, { signal: s.signal });
        s.timings.routeMs = Date.now() - t0;
        s.usages.push(r.usage);
        s.payment = { finishReason: r.finishReason, approvalId: r.approvalId, text: r.text };
        return { lane, finishReason: r.finishReason, approvalId: r.approvalId };
      },
    })
  );
  return reg;
}

// ---------------------------------------------------------------- the flow

export const apFlow = new FlowBuilder()
  .setCode('ap-invoice')
  .setName('AP invoice: extract -> validate -> route')
  .addInput({ name: 'docId', type: 'shortText', required: true })
  .setFlow({
    type: 'sequence',
    steps: [
      { type: 'toolCall', id: 'extract', tool: 'extract_invoice', arguments: { docId: '{{docId}}' }, outputVariable: 'extracted' },
      { type: 'toolCall', id: 'validate', tool: 'validate_invoice', arguments: { docId: '{{docId}}' }, outputVariable: 'validation' },
      {
        type: 'oneOf',
        id: 'route',
        options: [
          { condition: "validation.kind === 'not_invoice'", step: { type: 'toolCall', tool: 'route_invoice', arguments: { docId: '{{docId}}', lane: 'rejected' }, outputVariable: 'routed' } },
          { condition: 'validation.amountUsd < 1000 && validation.flagCount === 0', step: { type: 'toolCall', tool: 'route_invoice', arguments: { docId: '{{docId}}', lane: 'auto' }, outputVariable: 'routed' } },
          { step: { type: 'toolCall', tool: 'route_invoice', arguments: { docId: '{{docId}}', lane: 'approval' }, outputVariable: 'routed' } },
        ],
      },
    ],
  } as EditorStep)
  .build();
