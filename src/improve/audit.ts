import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { withFileLock } from '../storage/fileLock';

/** One change to an agent's harness or its self-healing state. */
export interface AuditEntry {
  /** The line number in the log, from 1. */
  seq: number;
  /** When it was written, as an ISO timestamp. */
  at: string;
  /** Who or what made the change: a loop stage, or `person:<name>`. */
  actor: 'gate' | 'canary' | 'monitor' | 'guard' | 'scheduler' | `person:${string}`;
  /** What happened. */
  action: 'propose' | 'apply' | 'reject' | 'stale' | 'rollback' | 'retire' | 'guard-pass' | 'guard-fail' | 'pause' | 'resume' | 'canary-start' | 'canary-end';
  /** The revision before the change. */
  from?: string;
  /** The revision after the change. */
  to?: string;
  /** The cycle that made the change. */
  cycle?: string;
  /** Why, as plain text of at most 500 characters. */
  reason: string;
  /** What the decision rested on. */
  evidence?: {
    /** The gate's verdict, as plain text. */
    gate?: string;
    /** Per-case pass counts before and after. */
    cases?: {
      /** The case. */
      caseId: string;
      /** The base harness's count, such as `1/3`. */
      base: string;
      /** The new harness's count. */
      final: string;
    }[];
    /** A continuous score before and after. */
    score?: {
      /** The score before. */
      before: number;
      /** The score after. */
      after: number;
      /** How many runs the score after is over. */
      runs: number;
    };
  };
  /** sha256 of the previous line, or `genesis` for the first entry. */
  prev: string;
  /** sha256 of this entry without `hash`, so an edited line fails at its own seq. */
  hash: string;
}

const LOG = path.join('.lousho', 'audit.jsonl');
const MAX_REASON = 500;
const MAX_NAME = 100;
const FORGED_TAG = /<\s*\/?\s*untrusted\b[^>]*>/gi;
const IMAGE = /!\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g;
const LINK = /\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g;
const HTML_TAG = /<\/?[a-z][^<>\n]{0,500}>/gi;

function unmark(text: string): string {
  const stripped = text.replace(FORGED_TAG, '');
  return stripped === text ? text : unmark(stripped);
}

function plain(text: string, max: number): string {
  const flat = unmark(text).replace(IMAGE, '$1').replace(LINK, '$1').replace(HTML_TAG, '');
  return flat.replace(/\s+/g, ' ').trim().slice(0, max);
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function logText(dir: string): string {
  const file = path.join(dir, LOG);
  return statSync(file, { throwIfNoEntry: false }) ? readFileSync(file, 'utf8') : '';
}

function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type AuditInput = Omit<AuditEntry, 'seq' | 'at' | 'prev' | 'hash'>;

function present<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

function cleanActor(actor: AuditEntry['actor']): AuditEntry['actor'] {
  return actor.startsWith('person:') ? `person:${plain(actor.slice('person:'.length), MAX_NAME)}` : actor;
}

function cleanEvidence(evidence: AuditEntry['evidence']): AuditEntry['evidence'] {
  if (evidence === undefined) return undefined;
  return present({ gate: evidence.gate === undefined ? undefined : plain(evidence.gate, MAX_REASON), cases: evidence.cases, score: evidence.score });
}

function sealed(fields: Omit<AuditEntry, 'hash'>): AuditEntry {
  const body = present(fields);
  return { ...body, hash: sha(JSON.stringify(body)) };
}

/** Appends one entry under a file lock; `seq` and `prev` are filled in. */
export async function appendAudit(dir: string, entry: AuditInput): Promise<AuditEntry> {
  const file = path.join(dir, LOG);
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, async () => {
    const text = logText(dir);
    const lines = linesOf(text);
    const last = lines.at(-1);
    const { actor, action, from, to, cycle, reason, evidence } = entry;
    const written = sealed({
      seq: lines.length + 1,
      at: new Date().toISOString(),
      actor: cleanActor(actor),
      action,
      from,
      to,
      cycle,
      reason: plain(reason, MAX_REASON),
      evidence: cleanEvidence(evidence),
      prev: last === undefined ? 'genesis' : sha(last),
    });
    const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${separator}${JSON.stringify(written)}\n`);
    return written;
  });
}

function parsed(line: string): AuditEntry | undefined {
  try {
    const value = JSON.parse(line) as AuditEntry;
    return typeof value === 'object' && value !== null && typeof value.seq === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the log, oldest first. */
export function readAudit(dir: string): AuditEntry[] {
  return linesOf(logText(dir)).flatMap((line) => parsed(line) ?? []);
}

function intact(line: string, index: number, previous: string | undefined): boolean {
  const entry = parsed(line);
  if (!entry || entry.seq !== index + 1) return false;
  if (entry.prev !== (previous === undefined ? 'genesis' : sha(previous))) return false;
  const { hash, ...fields } = entry;
  return hash === sha(JSON.stringify(fields));
}

/** Checks the hash chain; returns the first broken seq, or undefined. */
export function verifyAudit(dir: string): number | undefined {
  const lines = linesOf(logText(dir));
  const broken = lines.findIndex((line, index) => !intact(line, index, lines[index - 1]));
  return broken === -1 ? undefined : broken + 1;
}
