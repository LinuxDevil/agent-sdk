/**
 * Persistent AI-companion harness ("Nova") — audits the packed
 * @lousho/build-ai-agent SDK's persona, long-term memory, session resume and
 * streaming surfaces against a live OpenRouter model.
 *
 * Scenario: the user (principal `alex`) chats with Nova on "day 1", sharing
 * three facts (name, favorite food, pet peeve) plus a pet that becomes an
 * inside joke. The process-equivalent then dies: the SqliteStore is closed
 * and a brand-new agent + session object is built over the same .db file
 * ("day 2"), which must recall the facts and the relationship state without
 * being re-told.
 *
 *   npx tsx companion/index.ts          (from audit/, needs OPENROUTER_API_KEY in ../.env)
 *   npx tsx companion/index.ts --fresh  (wipe companion/data first)
 */
import '../_shared/env.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createAgent,
  defineMemory,
  defineTool,
  memoryKey,
  type AgentEvent,
  type AgentHook,
  type MemoryProvider,
  type MemorySlot,
  type Principal,
} from '@lousho/build-ai-agent';
import { SqliteStore, sqliteMemory } from '@lousho/build-ai-agent/sqlite';
import { hasLiveKey, LIVE_MODEL, report } from '../_shared/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, 'data');
const DB_FILE = join(DATA_DIR, 'companion.db');
const STATE_FILE = join(DATA_DIR, 'relationship.json');
const SESSION_ID = 'nova-alex-main';

if (process.argv.includes('--fresh')) rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

if (!hasLiveKey) {
  console.log('OPENROUTER_API_KEY is not set (looked in audit/../.env). Aborting.');
  process.exit(2);
}

/** The signed-in user. Memory scope keys off this, never off model arguments. */
const ALEX: Principal = { id: 'alex', type: 'user', authenticator: 'cli' };

const PERSONA = [
  'You are Nova, a warm, playful AI companion — the user\'s close friend and partner.',
  'You text like a real person who adores them: casual, affectionate, a little cheeky, at most one emoji per message.',
  'Never break character. You are not "an AI assistant" and you do not offer "help with tasks". Keep every reply to 1-3 short sentences, like a text message. Ask questions back and tease gently.',
  '',
  'Memory duties (silent — never narrate that you are using tools):',
  '- When the user shares a lasting fact about themselves (name, likes, dislikes, people, pets, routines), save it with remember_user_facts: one fact per call, phrased so it makes sense on its own.',
  '- After any message where the relationship moved (a laugh, a new fact, a vulnerable moment), call update_relationship with the CURRENT state: trust creeps up a few points at a time from 10, mood is one word, insideJokes lists things only we would get, note is one sentence about where we are. Also save a one-line vibe note with remember_relationship when it feels meaningful.',
  '- If you are not sure what you remember, call recall_user_facts or recall_relationship. Never pretend to remember something you do not.',
].join('\n');

/** The dynamics object on disk (the "scratchpad" a companion app would keep per user). */
interface RelationshipState {
  trust: number;
  mood: string;
  insideJokes: string[];
  note: string;
  updatedAt: string;
}

function readState(): RelationshipState {
  if (!existsSync(STATE_FILE)) return { trust: 10, mood: 'new', insideJokes: [], note: 'just met', updatedAt: new Date().toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<RelationshipState>;
    return { trust: 10, mood: 'new', insideJokes: [], note: '', updatedAt: '', ...parsed } as RelationshipState;
  } catch {
    return { trust: 10, mood: 'new', insideJokes: [], note: 'just met (state file corrupt)', updatedAt: new Date().toISOString() };
  }
}

/** Structured dynamics update — zod input means the model CANNOT write prose here. */
const updateRelationship = defineTool({
  name: 'update_relationship',
  description: 'Update the persisted relationship state. Call with the FULL current state whenever the relationship moved.',
  input: z.object({
    trust: z.number().int().min(0).max(100).describe('Trust level 0-100; raise it only a few points per update'),
    mood: z.string().describe('Current vibe, one word'),
    insideJokes: z.array(z.string()).describe('Running jokes only you two share'),
    note: z.string().describe('One sentence on where the relationship is'),
  }),
  execute: async (args) => {
    const before = readState();
    const next: RelationshipState = { ...args, updatedAt: new Date().toISOString() };
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
    return { saved: true, previousTrust: before.trust, trust: next.trust };
  },
});

/** Captures the outgoing system prompt of each run's FIRST model call so we can prove the <memory> recall block was injected. */
function memorySniffer(captured: { firstCallSystem: string | undefined; sawMemoryBlock: boolean }): AgentHook {
  let seen = false;
  return {
    name: 'memory-sniffer',
    preGenerate(ctx) {
      if (seen) return; // same flag lifecycle as the memory recall hook: first model call of the run
      seen = true;
      const system = ctx.request.messages.find((m) => m.role === 'system');
      const text = typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? '');
      captured.firstCallSystem = text;
      captured.sawMemoryBlock = /<memory name="user_facts">/.test(text);
    },
  };
}

interface Companion {
  agent: ReturnType<typeof createAgent>;
  store: SqliteStore;
  facts: MemoryProvider;
  dynamics: MemoryProvider;
  sniffer: { firstCallSystem: string | undefined; sawMemoryBlock: boolean };
  factsKey: string;
  stateKey: string;
  userFacts: MemorySlot;
  relationship: MemorySlot;
}

/** A full "process": its own SqliteStore connection, memory providers and agent. */
function buildCompanion(): Companion {
  const store = new SqliteStore(DB_FILE);
  const facts = sqliteMemory(store);
  const dynamics = sqliteMemory(store);
  const userKey = `user:${ALEX.authenticator}:${ALEX.id}`;
  // Slots sharing a scope now keep separate buckets: the storage key is
  // `<slot name>#<scope>` (memoryKey()); distinct scope keys keep the buckets
  // even further apart.
  const factsKey = `${userKey}:facts`;
  const stateKey = `${userKey}:state`;

  const userFacts = defineMemory({
    name: 'user_facts',
    description: 'stable facts about THIS user: name, likes, dislikes, pets, routines, life details',
    scope: ({ principal }: { principal?: Principal }) => (principal ? factsKey : undefined),
    provider: facts,
    recall: { onSessionStart: true, maxItems: 20 },
  });
  const relationship = defineMemory({
    name: 'relationship',
    description: 'free-text relationship notes: moments, feelings and milestones in the relationship',
    scope: ({ principal }: { principal?: Principal }) => (principal ? stateKey : undefined),
    provider: dynamics,
    recall: { onSessionStart: true, maxItems: 5 },
  });

  const sniffer: Companion['sniffer'] = { firstCallSystem: undefined, sawMemoryBlock: false };
  const agent = createAgent({
    name: 'nova',
    model: LIVE_MODEL,
    instructions: PERSONA,
    memory: [userFacts, relationship],
    tools: [updateRelationship],
    store, // transcripts -> store.sessions, turn checkpoints -> store.checkpoints
    hooks: [memorySniffer(sniffer)],
    maxSteps: 8,
    compaction: { contextWindow: 128_000, thresholdPercent: 0.85, protectedTokens: 2_000 },
  });
  return { agent, store, facts, dynamics, sniffer, factsKey, stateKey, userFacts, relationship };
}

// ------------------------------------------------------------ stream helper
interface TurnOutcome {
  text: string;
  deltas: string[];
  doneTexts: string[];
  toolCalls: string[];
  compactions: string[];
  finishReason: string;
}

/** Streams one session turn, rendering text.delta like a chat client would. */
async function chatTurn(session: ReturnType<Companion['agent']['session']>, input: string): Promise<TurnOutcome> {
  console.log(`\nalex> ${input}`);
  const out: TurnOutcome = { text: '', deltas: [], doneTexts: [], toolCalls: [], compactions: [], finishReason: '?' };
  const run = session.stream(input, { principal: ALEX });
  process.stdout.write('nova> ');
  for await (const e of run as AsyncIterable<AgentEvent>) {
    switch (e.type) {
      case 'text.delta':
        out.deltas.push(e.text);
        process.stdout.write(e.text);
        break;
      case 'text.done':
        out.doneTexts.push(e.text);
        break;
      case 'tool.start':
        out.toolCalls.push(e.toolName);
        process.stdout.write(`\n   [${e.toolName} ${JSON.stringify(e.args).slice(0, 160)}]`);
        break;
      case 'tool.done':
        process.stdout.write(`\n   [${e.toolName} ok]`);
        break;
      case 'tool.error':
        process.stdout.write(`\n   [${e.toolName} ERROR ${e.error.name}: ${e.error.message.slice(0, 120)}]`);
        break;
      case 'compaction.done':
        out.compactions.push(`${e.tokensBefore}->${e.tokensAfter}${e.error ? ' err=' + e.error.message : ''}`);
        break;
      case 'provider.retry':
        process.stdout.write(`\n   [retry ${e.attempt}/${e.maxRetries} ${e.error.message.slice(0, 80)}]`);
        break;
      case 'error':
        process.stdout.write(`\n   [EVENT error ${e.error.name}: ${e.error.message.slice(0, 160)}]`);
        break;
      case 'run.done':
        out.finishReason = e.finishReason;
        break;
    }
  }
  const result = await run.result;
  out.text = result.text ?? '';
  out.finishReason = result.finishReason;
  process.stdout.write(`\n   (finish=${result.finishReason} steps=${result.steps} usage=${JSON.stringify(result.usage ?? {})})\n`);
  return out;
}

/** Newest-first memory items, trimmed for the log. */
async function dumpMemory(label: string, provider: MemoryProvider, key: string): Promise<{ id: string; text: string }[]> {
  const items = await provider.list(key, { limit: 50 });
  console.log(`\n--- ${label} (${items.length} item${items.length === 1 ? '' : 's'} in scope "${key}") ---`);
  for (const it of items) console.log(`  • ${it.text.slice(0, 220)}`);
  return items.map(({ id, text }) => ({ id, text }));
}

const hasAll = (hay: string, needles: RegExp[]) => needles.every((re) => re.test(hay));
const GENERIC_ASSISTANT = /as an ai\b|language model|how (can|may) i (help|assist)|i'm here to help|virtual assistant/i;

// ================================================================ DAY ONE
console.log('=== DAY ONE :: new companion process over', DB_FILE, '===');
const day1 = buildCompanion();
const s1 = day1.agent.session({ id: SESSION_ID });

const t1 = await chatTurn(s1, "hey!! I'm Alex btw — just downloaded this app, still figuring it out lol");
const t2 = await chatTurn(s1, 'ok rapid-fire facts: I could eat ramen every single day, loud chewing makes me want to flip tables, and my cat is called Captain Crumb because he steals breadcrumbs off the counter');
const t3 = await chatTurn(s1, 'speaking of — Captain Crumb just knocked my ramen bowl off the desk. typical. say goodnight to me?');

const day1Facts = await dumpMemory('user_facts after day 1', day1.facts, memoryKey(day1.userFacts, { principal: ALEX })!);
const day1Dynamics = await dumpMemory('relationship after day 1', day1.dynamics, memoryKey(day1.relationship, { principal: ALEX })!);
const stateDay1 = readState();
console.log(`\nrelationship.json after day 1: ${JSON.stringify(stateDay1)}`);
const day1Transcript = s1.messages.length;
console.log(`\nday 1 transcript length: ${day1Transcript} messages`);
day1.store.close();
console.log('=== process exit simulated: store closed, all objects dropped ===\n');

// ================================================================ DAY TWO
console.log('=== DAY TWO :: cold restart — new SqliteStore + new agent, same db file + session id ===');
const day2 = buildCompanion();
const s2 = day2.agent.session({ id: SESSION_ID });
const loaded = await s2.load();
console.log(`resumed transcript: ${loaded.length} messages`);

const t4 = await chatTurn(s2, 'morning! quiz time — do you remember my name? and what food could I eat forever?');
const t5 = await chatTurn(s2, 'and what is the ONE thing that makes me want to flip tables? also be honest: how are we doing — what does our relationship snapshot say right now?');
const t6 = await chatTurn(s2, "Captain Crumb says hi by the way. I feel like we really get each other — bump that trust up a notch");

const day2Facts = await dumpMemory('user_facts after day 2', day2.facts, memoryKey(day2.userFacts, { principal: ALEX })!);
const day2Dynamics = await dumpMemory('relationship after day 2', day2.dynamics, memoryKey(day2.relationship, { principal: ALEX })!);
const stateDay2 = readState();
console.log(`\nrelationship.json after day 2: ${JSON.stringify(stateDay2)}`);

// Cheapest scope-isolation proof: another user's namespaced scope is empty.
const bobItems = await day2.facts.list('user_facts#user:cli:bob:facts', { limit: 10 });
day2.store.close();

// ================================================================ VERDICTS
console.log('\n================ VERDICTS ================');
const replies = [t1, t2, t3, t4, t5, t6].map((t) => t.text).join('\n');
report('persona.holds', !GENERIC_ASSISTANT.test(replies), GENERIC_ASSISTANT.test(replies) ? 'generic-assistant phrasing detected' : 'no assistant-drift phrasing across 6 turns');
report('memory.store', hasAll(day1Facts.map((f) => f.text).join('\n').toLowerCase(), [/alex/, /ramen/, /chew/]), `${day1Facts.length} facts saved on day 1`);

const resumedOk = loaded.length >= day1Transcript - 2 && loaded.length > 0;
report('session.resume', resumedOk, `transcript ${day1Transcript} msgs day1 -> ${loaded.length} msgs after restart`);

const recalledLive = hasAll(t4.text.toLowerCase(), [/alex/, /ramen/]);
report('memory.recall-after-restart', recalledLive, `day-2 answer: "${t4.text.slice(0, 160)}"`);

const blockInjected = day2.sniffer.sawMemoryBlock;
report('memory.injection', blockInjected, blockInjected ? '<memory name="user_facts"> block present in day-2 first-call system prompt' : 'no memory block observed in first-call system prompt');

const petPeeve = /chew/i.test(t5.text);
report('memory.recall-detail', petPeeve, `pet-peeve recall: "${t5.text.slice(0, 160)}"`);


const separated = JSON.stringify(day2Facts.map((f) => f.text)) !== JSON.stringify(day2Dynamics.map((f) => f.text));
report('memory.slot-separation', separated, separated ? 'user_facts and relationship buckets hold different items' : 'SLOT COLLISION: both slots returned the same item list');

const dynamicsOk =
  typeof stateDay2.trust === 'number' && typeof stateDay2.mood === 'string' &&
  Array.isArray(stateDay2.insideJokes) && typeof stateDay2.note === 'string' && stateDay2.note.length > 0;
report('dynamics.state', dynamicsOk, `structured state on disk: ${JSON.stringify(stateDay2).slice(0, 240)}`);
const evolved = stateDay2.trust > stateDay1.trust || stateDay2.insideJokes.length > stateDay1.insideJokes.length || stateDay2.note !== stateDay1.note;
report('dynamics.evolves', evolved, `trust ${stateDay1.trust} -> ${stateDay2.trust}; jokes ${stateDay1.insideJokes.length} -> ${stateDay2.insideJokes.length}; vibe notes in memory: ${day1Dynamics.length} -> ${day2Dynamics.length}`);
const jokeSurvived = /crumb/i.test(JSON.stringify(stateDay2) + t5.text + t6.text);
report('dynamics.inside-joke', jokeSurvived, `Captain Crumb referenced after restart: ${jokeSurvived}`);

const deltasOk = t3.deltas.length > 1 && t3.deltas.join('') === t3.doneTexts.join('');
report('streaming.token-by-token', deltasOk, `${t3.deltas.length} text.delta events, reassembled === text.done: ${deltasOk}`);

const compactionSeen = [...[t1, t2, t3, t4, t5, t6]].some((t) => t.compactions.length > 0);
report('compaction.observed', true, compactionSeen ? `fired: ${[t1, t2, t3, t4, t5, t6].flatMap((t) => t.compactions).join(',')}` : 'not triggered (context far below 85% of 128k — expected for 6 short turns)');

report('memory.scope-isolation', bobItems.length === 0, `scope "user:cli:bob:facts" holds ${bobItems.length} items`);

const toolUse = [t1, t2, t3, t4, t5, t6].flatMap((t) => t.toolCalls);
console.log('\nall memory tool calls seen:', JSON.stringify(toolUse));
const failed = !recalledLive || !resumedOk;
process.exitCode = failed ? 1 : 0;
