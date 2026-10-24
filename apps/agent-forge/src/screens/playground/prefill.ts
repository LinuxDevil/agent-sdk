/**
 * Pre-filling the Playground from a trace's generation (`?trace=&fromObs=`)
 * or a registry prompt (`?prompt=name@ref`). Pure: the screen fetches, these
 * read the payload.
 */
import type { ObserveObservationRow } from '../../observe/types';
import type { PlaygroundMessage, PlaygroundRole } from './types';

const ROLES = new Set<string>(['system', 'user', 'assistant']);
const SYSTEM_INSTRUCTIONS_ATTR = 'gen_ai.system_instructions';
const PROVIDER_ATTRS = ['gen_ai.provider.name', 'gen_ai.system'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Text of a message's `content` (a string or content parts) or gen_ai `parts`. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const texts = value
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : undefined))
    .filter((t): t is string => t !== undefined);
  return texts.length ? texts.join('\n') : undefined;
}

/** One OpenAI-style (`content`) or gen_ai (`parts`) message as an editor row; tool messages are dropped. */
function rowOf(value: unknown): PlaygroundMessage | undefined {
  if (!isRecord(value) || typeof value.role !== 'string' || !ROLES.has(value.role)) return undefined;
  const content = textOf(value.content) ?? textOf(value.parts) ?? '';
  return { role: value.role as PlaygroundRole, content };
}

/** The gen_ai system instructions attribute (a JSON array of text parts) as one system row. */
function systemOf(attrs: Record<string, unknown> | null): PlaygroundMessage | undefined {
  const raw = attrs?.[SYSTEM_INSTRUCTIONS_ATTR];
  const text = textOf(typeof raw === 'string' ? (parseJson(raw) ?? raw) : raw);
  return text ? { role: 'system', content: text } : undefined;
}

/**
 * The editor rows for an observation's input: an OpenAI-style message array,
 * `{messages}`, or gen_ai parts; anything else (plain text, truncated JSON)
 * becomes one user message. A system row from the gen_ai attrs comes first.
 */
export function messagesFromObservation(row: ObserveObservationRow): PlaygroundMessage[] {
  if (row.input === null || row.input === '') return [];
  const parsed = parseJson(row.input);
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.messages) ? parsed.messages : undefined;
  if (!list) return [{ role: 'user', content: row.input }];
  const rows = list.map(rowOf).filter((m): m is PlaygroundMessage => m !== undefined);
  const system = systemOf(row.attrs);
  return system && !rows.some((m) => m.role === 'system') ? [system, ...rows] : rows;
}

/** The observation's model as picker values: the provider from attrs (or a `provider/` prefix), else blank. */
export function modelFromObservation(row: ObserveObservationRow): { provider: string; model: string } | undefined {
  if (!row.model) return undefined;
  const fromAttrs = PROVIDER_ATTRS.map((key) => row.attrs?.[key]).find((v): v is string => typeof v === 'string' && v !== '');
  // A model already recorded as `provider/model` keeps one prefix, not two.
  if (fromAttrs) return { provider: fromAttrs, model: row.model.startsWith(`${fromAttrs}/`) ? row.model.slice(fromAttrs.length + 1) : row.model };
  const slash = row.model.indexOf('/');
  return slash > 0 ? { provider: row.model.slice(0, slash), model: row.model.slice(slash + 1) } : { provider: '', model: row.model };
}

/** `name[@ref]` from `?prompt=`; the ref defaults to `latest`. */
export function parsePromptParam(param: string | null): { name: string; ref: string } | undefined {
  if (!param) return undefined;
  const at = param.lastIndexOf('@');
  if (at <= 0) return { name: param, ref: 'latest' };
  return { name: param.slice(0, at), ref: param.slice(at + 1) || 'latest' };
}
