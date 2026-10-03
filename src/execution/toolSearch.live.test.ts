/**
 * Live test for tool search (N2): 40 small tools marked `deferLoading` on
 * openai/gpt-4o-mini through OpenRouter, `toolSearch: { thresholdPercent: 0 }`,
 * `maxSteps: 4`. The model finds `convert_currency` with `tool_search`, calls
 * it and answers. One more call with the same 40 tools sent upfront measures
 * what deferral saves on the first call's input tokens.
 *
 * - Replay (default): served from `__fixtures__/cassettes/n2-tool-search.json`, free.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set (at most 0.05 USD).
 *   Grep the cassette for `sk-or-` and `Authorization` before committing it.
 *
 * Skipped when the cassette is missing and no key is set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import { defineTool, type DefinedTool } from '../tools/defineTool';

const CASSETTE = path.join(__dirname, '__fixtures__', 'cassettes', 'n2-tool-search.json');
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(CASSETTE);

/** 40 one-line tools, each with a fixed result. */
const CATALOG: Array<[string, string]> = [
  ['get_weather', 'Get the current weather for a city'],
  ['convert_currency', 'Convert an amount of money from one currency to another'],
  ['lookup_stock', 'Look up the latest price of a stock ticker'],
  ['send_email', 'Send an email to a recipient'],
  ['create_calendar_event', 'Create an event in the calendar'],
  ['list_calendar_events', 'List upcoming calendar events'],
  ['translate_text', 'Translate text into another language'],
  ['search_web', 'Search the web for pages'],
  ['get_news', 'Get the latest news headlines on a topic'],
  ['book_flight', 'Book a flight between two airports'],
  ['find_hotel', 'Find hotels in a city'],
  ['get_directions', 'Get driving directions between two places'],
  ['set_reminder', 'Set a reminder at a time'],
  ['create_note', 'Create a note'],
  ['search_notes', 'Search saved notes'],
  ['create_ticket', 'Open a support ticket'],
  ['close_ticket', 'Close a support ticket'],
  ['get_order_status', 'Get the status of an order'],
  ['refund_order', 'Refund an order'],
  ['list_invoices', 'List invoices of a customer'],
  ['get_customer', 'Look up a customer record'],
  ['update_customer', 'Update a customer record'],
  ['run_sql', 'Run a read-only SQL query'],
  ['get_time', 'Get the current time in a time zone'],
  ['define_word', 'Look up the definition of a word'],
  ['get_recipe', 'Find a recipe for a dish'],
  ['track_package', 'Track a parcel by tracking number'],
  ['get_exchange_holidays', 'List stock exchange holidays'],
  ['create_invoice', 'Create an invoice for a customer'],
  ['send_sms', 'Send a text message to a phone number'],
  ['post_message', 'Post a message to a chat channel'],
  ['list_files', 'List files in a folder'],
  ['read_file', 'Read a file'],
  ['summarize_document', 'Summarize a document'],
  ['generate_password', 'Generate a random password'],
  ['shorten_url', 'Shorten a long URL'],
  ['check_domain', 'Check whether a domain name is available'],
  ['get_air_quality', 'Get the air quality index for a city'],
  ['calculate_tax', 'Calculate sales tax for an amount'],
  ['get_population', 'Get the population of a country'],
];

function tools(deferLoading: boolean): DefinedTool[] {
  return CATALOG.map(([name, description]) =>
    name === 'convert_currency'
      ? defineTool({
          name,
          description,
          deferLoading,
          input: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
          execute: ({ amount, to }) => ({ amount: Math.round(amount * 0.92 * 100) / 100, currency: to }),
        })
      : defineTool({ name, description, deferLoading, input: z.object({ query: z.string().optional() }), execute: () => ({ ok: true, tool: name }) })
  );
}

describe.skipIf(!runnable)('tool search live (N2)', () => {
  it('the model finds convert_currency with tool_search, calls it and answers; deferral shrinks the first call', async () => {
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: CASSETTE, mode: recording ? 'record' : 'replay' });
    const instructions = 'You are a helpful assistant. Use tools to answer. Keep answers short.';
    const deferred = createAgent({ provider, instructions, maxSteps: 4, tools: tools(true), toolSearch: { thresholdPercent: 0 } });
    const result = await deferred.send('What is 100 USD in EUR?');

    const called = result.toolCalls.map((call) => call.function.name);
    expect(called[0]).toBe('tool_search');
    expect(called).toContain('convert_currency');
    expect(called.indexOf('convert_currency')).toBeGreaterThan(called.indexOf('tool_search'));
    expect(result.finishReason).toBe('stop');
    expect(result.text).toMatch(/92/);

    // The same 40 tools, sent upfront: one model call.
    const upfront = createAgent({ provider, instructions, maxSteps: 1, tools: tools(false) });
    const baseline = await upfront.send('What is 100 USD in EUR?');
    const withDeferral = result.stepUsage?.[0]?.usage.inputTokens ?? 0;
    const withoutDeferral = baseline.stepUsage?.[0]?.usage.inputTokens ?? 0;
    console.log(`N2 first-call input tokens: ${withDeferral} with deferral, ${withoutDeferral} without`);
    expect(withDeferral).toBeGreaterThan(0);
    expect(withDeferral).toBeLessThan(withoutDeferral);
  });
});
