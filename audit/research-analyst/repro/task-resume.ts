/**
 * Repro (live, ~3 model calls): LOU-Y6 task continuation. Turn 1 of a
 * session fans out one `task`; turn 2 resumes that task by taskId, so the
 * sub-agent answers a follow-up with its earlier work in context. Needs a
 * store (task records live in store.sessions for session runs).
 * Run: npx tsx research-analyst/repro/task-resume.ts
 */
import '../../_shared/env.js';
import { z } from 'zod';
import { createAgent, defineTool, memoryStore, toolResultText } from '@lousho/build-ai-agent';
import { hasLiveKey, LIVE_MODEL, report } from '../../_shared/env.js';
import { CORPUS, searchCorpus } from '../corpus.js';

if (!hasLiveKey) {
  report('task-resume', false, 'no OPENROUTER_API_KEY');
  process.exit(1);
}

const search = defineTool({
  name: 'knowledge_search',
  description: 'Search Node.js memory notes; returns entries with C# ids.',
  input: z.object({ query: z.string() }),
  execute: async ({ query }) => searchCorpus(query).map(({ id, title, text }) => ({ id, title, text })),
});

const researcher = createAgent({
  name: 'researcher',
  description: 'Researches one Node.js slice; brief cited with [C#] ids.',
  instructions: 'Always call knowledge_search once, then answer in 2-3 bullets ending with [C#] ids.',
  model: LIVE_MODEL,
  tools: [search],
  maxSteps: 4,
});

const coordinator = createAgent({
  name: 'coordinator',
  instructions:
    'You coordinate a researcher sub-agent via the task tool. Task results end with a taskId footer; ' +
    'to ask a task a follow-up, call task again with that taskId (mode "resume"). Relay answers faithfully.',
  model: LIVE_MODEL,
  subagents: { researcher },
  store: memoryStore(),
  maxSteps: 6,
});

const session = coordinator.session();
const turn1 = await session.send('Delegate one slice to researcher: "event-loop impact of memory pressure". One task call.');
const ids = [...JSON.stringify(turn1.messages).matchAll(/taskId '([^']+)'/g)].map((m) => m[1]);
const taskId = ids[0];
report('turn 1 produced a taskId', taskId !== undefined, `taskId=${taskId ?? 'none'}`);

if (taskId) {
  const turn2 = await session.send(
    `Call task with agent "researcher", taskId "${taskId}" and prompt: "In your earlier brief, which corpus id did you cite FIRST? Reply with just the id." — description "follow-up citation".`
  );
  // NOTE: a session turn's result.messages is the WHOLE transcript (turn 1 included) — slice to this turn.
  const newMessages = turn2.messages.slice(turn1.messages.length);
  const taskMsgs = newMessages.filter((m) => m.role === 'tool' && m.toolName === 'task');
  const answer = taskMsgs.map((m) => toolResultText(m)).join('\n');
  const citesCid = /C[1-8]/.test(answer);
  const notFound = /NOT_FOUND|not found|Unknown/i.test(answer);
  report(
    'task resume by taskId keeps context',
    taskMsgs.length === 1 && citesCid && !notFound,
    `task calls=${taskMsgs.length} answer has C# id=${citesCid} error=${notFound} answer=${answer.slice(0, 160).replace(/\n/g, ' ')}`
  );
}

// Corpus import sanity (kept referenced so tsx doesn't tree-shake the fixture away in IDE runs).
void CORPUS;
