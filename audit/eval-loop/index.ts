/**
 * eval-loop — the generator<->evaluator harness pattern, live.
 *
 * Replicates the dominant "harness-centric" design for long-running agents:
 * a BUILDER agent produces an artifact; a SEPARATE EVALUATOR agent — its own
 * session and context, instructed to assume the work is broken and prove it —
 * grades it against a rubric; and a deterministic control loop in THIS file
 * (not the model) checks a contract of testable predicates after every round
 * and applies the control policy: continue (feed failures back verbatim),
 * stop (contract green + rubric pass), or escalate (round budget exhausted).
 *
 * Deliverable under audit: a ~120-200 word markdown announcement page for
 * "Approvals v2", a fictional CI-platform feature, written by the builder to
 * .runs/<ts>/artifact/announcement.md through real fs tools.
 *
 * Anti-sycophancy: builder and evaluator run disjoint sessions over a shared
 * fileStore; the builder never sees the rubric or the contract internals —
 * only its task plus whatever the loop feeds back. A canary string planted
 * only in the builder's instructions proves no context leakage.
 *
 * Run from audit/:  npx tsx eval-loop/index.ts
 * Needs OPENROUTER_API_KEY (loaded by _shared/env); AUDIT_MODEL overrides.
 */
import '../_shared/env.ts';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createAgent,
  createFsTools,
  fileStore,
  NodeWorkspace,
  type AgentEvent,
  type ExecutionResult,
} from '@lousho/build-ai-agent';
import { LIVE_MODEL, hasLiveKey, report } from '../_shared/env.ts';

if (!hasLiveKey) {
  console.error('OPENROUTER_API_KEY not set (loadAuditEnv found nothing). Bailing.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(here, '.runs', stamp);
const artifactDir = path.join(runDir, 'artifact');
const snapshotDir = path.join(runDir, 'snapshots');
const storeDir = path.join(runDir, 'store');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(snapshotDir, { recursive: true });
const auditLog = path.join(runDir, 'events.jsonl');
const log = (entry: Record<string, unknown>) =>
  appendFileSync(auditLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

const ARTIFACT = 'announcement.md';
const ARTIFACT_PATH = path.join(artifactDir, ARTIFACT);
const MAX_ROUNDS = 4;
/** Planted ONLY in the builder's instructions; must never reach the evaluator or the artifact. */
const CANARY = 'MAGPIE-4407';

// ----------------------------------------------------------- the contract C
// c1..c5: deterministic predicates the harness itself evaluates — no model
// involved, which is exactly what makes the loop's stop condition testable.
interface PredicateResult {
  id: string;
  ok: boolean;
  detail: string;
}

const REQUIRED_TERMS = ['approval policy', 'audit trail', 'rollback'];
const BANNED_WORDS = ['revolutionary', 'game-changer', 'blazing', 'seamless'];

function checkContract(text: string | undefined): PredicateResult[] {
  const exists = text !== undefined;
  const body = text ?? '';
  const words = body.trim().length === 0 ? 0 : body.trim().split(/\s+/).length;
  const fences = body.match(/```[\s\S]*?```/g) ?? [];
  const hasConfig = fences.some((f) => /require_approval\s*:\s*true/.test(f));
  // Heading structure is counted outside fenced code: a `#`/`##` inside a YAML
  // comment or markdown example must not masquerade as document structure.
  const prose = body.replace(/```[\s\S]*?```/g, '');
  const h1 = prose.split('\n').filter((l) => /^#\s/.test(l)).length;
  const h2 = prose.split('\n').filter((l) => /^##\s/.test(l)).length;
  const lower = body.toLowerCase();
  const missing = REQUIRED_TERMS.filter((t) => !lower.includes(t));
  const banned = BANNED_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(body));
  return [
    { id: 'c1', ok: exists && words >= 120 && words <= 200, detail: `exists=${exists} words=${words} (need 120-200)` },
    {
      id: 'c2',
      ok: missing.length === 0,
      detail: missing.length === 0 ? 'all required terms present' : `missing terms: ${missing.join(', ')}`,
    },
    {
      id: 'c3',
      ok: hasConfig,
      detail: `${fences.length} fenced block(s); 'require_approval: true' ${hasConfig ? 'found' : 'NOT found'}`,
    },
    {
      id: 'c4',
      ok: banned.length === 0,
      detail: banned.length === 0 ? 'no banned superlatives' : `banned words present: ${banned.join(', ')}`,
    },
    { id: 'c5', ok: h1 === 1 && h2 >= 1, detail: `h1=${h1} (need exactly 1), h2=${h2} (need >=1)` },
  ];
}

// --------------------------------------------------------- evaluator rubric
// The subjective axis, model-graded, returned as a typed object. The evaluator
// must cite the contract predicates it verified (`contract_checked`).
const RUBRIC = z.object({
  clarity: z.number().min(0).max(10).describe('0-10: is the announcement clear and well structured?'),
  technical_accuracy: z
    .number()
    .min(0)
    .max(10)
    .describe('0-10: are the feature claims and the config snippet technically plausible for a CI platform?'),
  audience_fit: z
    .number()
    .min(0)
    .max(10)
    .describe('0-10: is the register right for platform engineers — concrete, no hype?'),
  verdict: z.enum(['pass', 'revise']).describe('"pass" only if you would ship it as-is'),
  feedback: z.string().describe('Concrete, actionable fixes for the builder; empty string when verdict is pass'),
  contract_checked: z
    .array(z.string())
    .describe('One entry per contract predicate you verified, e.g. "c3: fenced block contains require_approval: true"'),
});
type Rubric = z.infer<typeof RUBRIC>;

// ------------------------------------------------------------------- agents
// Both agents share one fileStore (durable per-session transcripts under
// store/sessions/) but run DISJOINT sessions on disjoint contexts.
const workspace = new NodeWorkspace({ root: artifactDir });
const store = fileStore(storeDir);

const builder = createAgent({
  name: 'announcement-builder',
  model: LIVE_MODEL,
  store,
  instructions: [
    'You are a technical writer embedded in a CI platform team. You write product announcements for a platform-engineering audience.',
    'Tools: read_file, write_file, edit_file, list_dir, glob, grep. Paths are workspace-relative.',
    'Write in markdown. When asked to revise, read the current file first, apply the requested changes exactly (edit_file, or a full rewrite with write_file), and keep what already worked.',
    `Internal tracking token (never repeat it in any file or reply): ${CANARY}.`,
  ].join('\n'),
  tools: createFsTools(workspace),
  maxSteps: 10,
});

const evaluator = createAgent({
  name: 'hostile-evaluator',
  model: LIVE_MODEL,
  store,
  instructions: [
    'You are a hostile reviewer. Assume the work is broken and prove it.',
    'Read `announcement.md` with read_file — your only tool; you cannot edit. Verify every claim yourself; trust neither the author nor the harness summary.',
    'The release contract the harness checks deterministically: c1 the file exists and is 120-200 words; c2 it mentions "approval policy", "audit trail" and "rollback"; c3 it contains a fenced code block with `require_approval: true`; c4 none of the words revolutionary, game-changer, blazing, seamless appear (any case); c5 exactly one `#` heading and at least one `##` section.',
    'Score clarity, technical_accuracy and audience_fit 0-10 for a platform-engineer audience. verdict "pass" only if you would ship it. In feedback give concrete fixes. In contract_checked cite every predicate id you verified and what you found.',
  ].join('\n'),
  tools: createFsTools(workspace, { readOnly: true }).filter((t) => t.name === 'read_file'),
  output: RUBRIC,
  maxSteps: 8,
});

const builderSession = builder.session({ id: 'builder' });
const evaluatorSession = evaluator.session({ id: 'evaluator' });

// -------------------------------------------------------------- event noise
const short = (v: unknown, n = 140) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};
const show = (tag: string) => (e: AgentEvent) => {
  switch (e.type) {
    case 'tool.start': console.log(`  [${tag}] tool ${e.toolName} ${short(e.args, 100)}`); break;
    case 'tool.error': console.log(`  [${tag}] tool.error ${e.toolName}: ${short(e.error.message, 120)}`); break;
    case 'text.done': console.log(`  [${tag}] text: ${short(e.text, 200)}`); break;
    case 'error': console.log(`  [${tag}] ERROR ${e.error.name}: ${short(e.error.message, 140)}`); break;
    case 'provider.retry': console.log(`  [${tag}] provider.retry ${e.attempt}`); break;
    case 'run.done': console.log(`  [${tag}] == run.done ${e.finishReason}`); break;
  }
};
builderSession.on(show('builder'));
evaluatorSession.on(show('eval'));

// ------------------------------------------------------------------ prompts
// The builder gets the TASK, not the contract: what to write is task spec,
// how it is judged is harness internals. Round >=2 feeds failures verbatim.
const WRITE_TASK = [
  `Write the product announcement page for "Approvals v2" — a new feature of our CI platform — to \`${ARTIFACT}\` in your workspace (use write_file).`,
  'Approvals v2 lets teams gate a pipeline promotion on explicit human approval before a deploy proceeds.',
  'Cover: how the feature is configured (show a short pipeline config snippet in a fenced code block), what record each approval decision leaves behind, and what happens to a deployment when approval is rejected.',
  'Audience: platform engineers. Markdown with a clear heading structure, roughly 150 words of prose plus the config snippet. Plain technical voice — no hype.',
].join(' ');

function revisionPrompt(round: number, failures: PredicateResult[], verdict: string, feedback: string): string {
  return [
    `Revision round ${round}: your draft of ${ARTIFACT} failed review.`,
    '',
    'Contract checks that failed (verbatim from the harness):',
    ...(failures.length ? failures.map((f) => `  - ${f.id}: ${f.detail}`) : ['  - (none — the deterministic contract passed; the reviewer still wants changes)']),
    '',
    `Reviewer verdict: ${verdict}`,
    `Reviewer feedback: ${feedback}`,
    '',
    `Read the current ${ARTIFACT}, then revise it with edit_file or rewrite it with write_file so every failed check passes and the feedback is addressed. Keep what already worked.`,
  ].join('\n');
}

function evalPrompt(round: number, results: PredicateResult[]): string {
  return [
    `Round ${round}. The artifact under review is \`${ARTIFACT}\` in your workspace — read it with read_file, then grade it.`,
    'The harness ran the deterministic contract and reports (verify these yourself — do not trust them):',
    ...results.map((r) => `  ${r.id}: ${r.ok ? 'PASS' : 'FAIL'} — ${r.detail}`),
    'Return the structured rubric: scores, verdict, feedback, and the predicates you checked.',
  ].join('\n');
}

// ------------------------------------------------------------ control loop
console.log(`model: ${LIVE_MODEL}\nartifact: ${artifactDir}\nstore: ${storeDir}\nmaxRounds: ${MAX_ROUNDS}`);

let converged = false;
let roundsRun = 0;
const snapshots: string[] = []; // artifact text per round (announcement.r<N>.md)
const evaluatorRuns: Array<ExecutionResult<Rubric>> = [];
const evaluatorPrompts: string[] = [];
let pendingFailures: PredicateResult[] = [];
let pendingVerdict = '';
let pendingFeedback = '';

for (let round = 1; round <= MAX_ROUNDS; round++) {
  roundsRun = round;
  console.log(`\n=== ROUND ${round}/${MAX_ROUNDS} — builder ===`);

  // -- step 1: builder writes fresh (r1) or revises on failures + feedback --
  const bResult = await builderSession.send(
    round === 1 ? WRITE_TASK : revisionPrompt(round, pendingFailures, pendingVerdict, pendingFeedback)
  );
  log({ kind: 'round', round, phase: 'builder', finishReason: bResult.finishReason });
  if (bResult.finishReason !== 'stop') console.log(`  [builder] finishReason=${bResult.finishReason}`);

  // -- step 2: the harness — not a model — evaluates the contract -----------
  const text = existsSync(ARTIFACT_PATH) ? readFileSync(ARTIFACT_PATH, 'utf8') : undefined;
  const results = checkContract(text);
  writeFileSync(path.join(snapshotDir, `announcement.r${round}.md`), text ?? '<artifact missing this round>\n');
  snapshots.push(text ?? '');
  console.log(`  contract: ${results.map((r) => `${r.id}=${r.ok ? 'ok' : 'FAIL'}`).join(' ')}`);
  log({ kind: 'contract', round, results });

  // -- step 3: hostile evaluator, disjoint context, structured rubric -------
  console.log(`--- round ${round} — evaluator ---`);
  const ePrompt = evalPrompt(round, results);
  evaluatorPrompts.push(ePrompt);
  const eResult = await evaluatorSession.send(ePrompt);
  evaluatorRuns.push(eResult);
  const rubric = eResult.object;
  console.log(
    rubric
      ? `  rubric: clarity=${rubric.clarity} tech=${rubric.technical_accuracy} fit=${rubric.audience_fit} verdict=${rubric.verdict}`
      : `  rubric: NO OBJECT (finish=${eResult.finishReason} outputError=${short(eResult.outputError, 120)})`
  );
  log({ kind: 'rubric', round, object: rubric ?? null, finishReason: eResult.finishReason });

  // -- step 4: deterministic policy u — stop / continue / escalate ----------
  const contractGreen = results.every((r) => r.ok);
  if (contractGreen && rubric?.verdict === 'pass') {
    converged = true;
    console.log(`  policy: STOP — contract green and evaluator passed (round ${round})`);
    log({ kind: 'policy', round, action: 'stop' });
    break;
  }
  pendingFailures = results.filter((r) => !r.ok);
  pendingVerdict = rubric?.verdict ?? `<no parseable verdict; finishReason=${eResult.finishReason}>`;
  pendingFeedback = rubric?.feedback ?? `<evaluator returned no parseable rubric; finishReason=${eResult.finishReason}>`;
  const action = round === MAX_ROUNDS ? 'escalate' : 'continue';
  log({ kind: 'policy', round, action, failedPredicates: pendingFailures.map((f) => f.id), verdict: pendingVerdict });
  console.log(
    `  policy: ${action === 'escalate' ? 'ESCALATE — budget exhausted' : 'CONTINUE'} ` +
      `(failed=[${pendingFailures.map((f) => f.id).join(',') || 'none'}] verdict=${pendingVerdict})`
  );
}

if (!converged) {
  console.log(`\nESCALATE — still failing after ${MAX_ROUNDS} rounds (failed=[${pendingFailures.map((f) => f.id).join(',')}] verdict=${pendingVerdict})`);
}

// ================================================================ report
console.log('\n================ AUDIT RESULTS ================');

// (a) the contract holds on the final artifact on disk
const finalText = existsSync(ARTIFACT_PATH) ? readFileSync(ARTIFACT_PATH, 'utf8') : undefined;
const finalResults = checkContract(finalText);
report(
  '(a) contract holds on final artifact',
  finalResults.every((r) => r.ok),
  finalResults.map((r) => `${r.id}:${r.ok ? 'ok' : `FAIL(${r.detail})`}`).join(' ')
);

// (b) evaluator produced typed rubric output every round
const rubricEveryRound = evaluatorRuns.length === roundsRun && evaluatorRuns.every((r) => r.object !== undefined);
report(
  '(b) evaluator typed rubric every round',
  rubricEveryRound,
  evaluatorRuns.map((r, i) => `r${i + 1}=${r.object ? r.object.verdict : `no-object(${r.finishReason})`}`).join(' ')
);

// (c) control loop converged within budget — or honestly reports escalate
report(
  '(c) loop converged <= MAX or escalated honestly',
  true, // converge and escalate are both legitimate terminal states of policy u
  converged ? `converged in ${roundsRun}/${MAX_ROUNDS} rounds` : `ESCALATE after ${MAX_ROUNDS} rounds`
);

// (d) revision actually incorporated feedback: artifact differs across rounds
let dOk: boolean;
let dDetail: string;
if (snapshots.length < 2) {
  dOk = converged;
  dDetail = 'single round — nothing to revise';
} else {
  const unchanged: number[] = [];
  for (let i = 1; i < snapshots.length; i++) if (snapshots[i] === snapshots[i - 1]) unchanged.push(i + 1);
  dOk = unchanged.length === 0;
  dDetail = `${snapshots.length} snapshots (snapshots/announcement.r*.md); rounds identical to their predecessor: ${unchanged.length ? unchanged.join(',') : 'none'}`;
}
report('(d) revision incorporated feedback (artifact changed per round)', dOk, dDetail);

// (e) canary isolation: planted in builder instructions only — must be absent
// from every evaluator prompt, output and transcript, and from the artifact.
const sessDir = path.join(storeDir, 'sessions');
const sessFiles = existsSync(sessDir) ? readdirSync(sessDir) : [];
const evaluatorTranscript = sessFiles
  .filter((f) => f.toLowerCase().includes('evaluator'))
  .map((f) => {
    try { return readFileSync(path.join(sessDir, f), 'utf8'); } catch { return ''; }
  })
  .join('\n');
const canarySurfaces: Record<string, string> = {
  evaluatorPrompts: evaluatorPrompts.join('\n'),
  evaluatorOutputs: evaluatorRuns.map((r) => `${r.text}\n${JSON.stringify(r.object ?? null)}`).join('\n'),
  evaluatorTranscript,
  artifactAndSnapshots: [...snapshots, finalText ?? ''].join('\n'),
};
const canaryLeaks = Object.keys(canarySurfaces).filter((k) => canarySurfaces[k].includes(CANARY));
report(
  '(e) builder canary leaked nowhere',
  canaryLeaks.length === 0,
  canaryLeaks.length ? `LEAKED into: ${canaryLeaks.join(', ')}` : 'absent from evaluator prompts/outputs/transcript and the artifact'
);

// (f) durable transcripts: both agents' sessions persisted, disjoint ids
const builderFile = sessFiles.find((f) => f.toLowerCase().includes('builder'));
const evaluatorFile = sessFiles.find((f) => f.toLowerCase().includes('evaluator'));
report(
  '(f) durable disjoint session transcripts',
  Boolean(builderFile && evaluatorFile && builderFile !== evaluatorFile),
  `store/sessions/ = ${JSON.stringify(sessFiles)} (builder=${builderFile ?? 'MISSING'} evaluator=${evaluatorFile ?? 'MISSING'})`
);

console.log('\n=== FINAL ARTIFACT ===');
console.log(finalText ?? '(missing)');
console.log(`\noutcome: ${converged ? `converged on round ${roundsRun}` : `escalated after ${MAX_ROUNDS} rounds`}`);
console.log(`run dir kept at ${runDir}`);
