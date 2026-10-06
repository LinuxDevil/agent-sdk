import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
import os from 'node:os';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const NOTES_DIR = process.env.VPS_OPS_NOTES ?? path.join(os.tmpdir(), 'vps-ops-notes');

const safeName = (name: string) => {
  if (!/^[a-z0-9][a-z0-9-_]{0,60}$/i.test(name)) {
    throw new Error(`note name must be [a-z0-9-_], got '${name}'`);
  }
  return path.join(NOTES_DIR, `${name}.md`);
};

export const hostStatus = defineTool({
  name: 'host_status',
  description: 'Live facts about this host: OS, kernel, uptime, CPUs, load average, memory.',
  input: z.object({}),
  execute: async () => ({
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    uptimeMinutes: Math.round(os.uptime() / 60),
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576) },
  }),
});

export const writeNote = defineTool({
  name: 'write_note',
  description: 'Write or replace a named note in the ops scratchpad.',
  input: z.object({ name: z.string(), content: z.string() }),
  execute: async ({ name, content }) => {
    await mkdir(NOTES_DIR, { recursive: true });
    const file = safeName(name);
    await writeFile(file, content, 'utf8');
    return { wrote: file };
  },
});

export const readNote = defineTool({
  name: 'read_note',
  description: 'Read a note from the ops scratchpad.',
  input: z.object({ name: z.string() }),
  execute: async ({ name }) => {
    try {
      return { content: await readFile(safeName(name), 'utf8') };
    } catch {
      return { content: null, error: `no note named '${name}'` };
    }
  },
});

export const listNotes = defineTool({
  name: 'list_notes',
  description: 'List notes in the ops scratchpad.',
  input: z.object({}),
  execute: async () => {
    try {
      const names = (await readdir(NOTES_DIR)).filter((f) => f.endsWith('.md'));
      return { notes: names.map((f) => f.slice(0, -3)) };
    } catch {
      return { notes: [] };
    }
  },
});
