/**
 * repo-maintainer: a GitHub PR-review bot audited live against the packed SDK.
 *
 *   Webhook (HMAC-verified pull_request.opened) -> review agent reads the diff
 *   and the repo through fs tools -> typed structured review -> post_comment
 *   pauses for approval -> approval (HTTP route or `/approve` comment) ->
 *   comment written to .runs/<ts>/review-comment-<n>.json.
 *
 * Exercises: channels (githubChannel + webhookChannel verify/parse/reply,
 * mountChannels approvals route), workspace fs tools, `output` structured
 * output, approval-gated tools, tool_search deferred tools, skills
 * (load_skill), agent.onEvent.
 *
 *   npx tsx repo-maintainer/index.ts [--skip-github] [--skip-deny] [--max-steps 30]
 */
import { hasLiveKey, LIVE_MODEL, report } from '../_shared/env.js';
import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createAgent,
  createFsTools,
  defineSkill,
  defineTool,
  githubChannel,
  mountChannels,
  NodeWorkspace,
  webhookChannel,
  type AgentEvent,
} from '@lousho/build-ai-agent';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture-repo');
const argv = process.argv.slice(2);
const arg = (name: string) => argv.includes(name);
const argValue = (name: string, dflt: number) => Number(argv[argv.indexOf(name) + 1]) || dflt;
const maxSteps = argValue('--max-steps', 45);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(here, '.runs', RUN_ID);
const repoDir = path.join(runDir, 'repo');
mkdirSync(repoDir, { recursive: true });
cpSync(fixture, repoDir, { recursive: true });

const auditLog = path.join(runDir, 'audit.jsonl');
const httpLog = path.join(runDir, 'http.jsonl');
const log = (file: string, entry: Record<string, unknown>) =>
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : String(JSON.stringify(v));
  return s.length > n ? s.slice(0, n) + '…' : s;
};

if (!hasLiveKey) {
  console.error('OPENROUTER_API_KEY missing (expected in E:\\agent-sdk\\.env). Aborting.');
  process.exit(2);
}

// ------------------------------------------------------------------ agent
const workspace = new NodeWorkspace({ root: repoDir });

let commentSeq = 0;
/** The "GitHub API" our bot posts through: an approved call writes a JSON file. */
const postComment = defineTool({
  name: 'post_comment',
  description:
    'Post a comment on the pull request being reviewed. This is a write to GitHub: it always requires human approval before it runs.',
  input: z.object({ body: z.string().describe('The full markdown review comment to post on the PR.') }),
  needsApproval: true,
  async execute({ body }) {
    commentSeq += 1;
    const file = path.join(runDir, `review-comment-${commentSeq}.json`);
    writeFileSync(file, JSON.stringify({ pr: 42, postedAt: new Date().toISOString(), body }, null, 2));
    return 'POSTED: the review comment is now on the PR. The only remaining step is your final answer: the structured JSON review object, with no further tool calls.';
  },
});

// Six domain tools, all deferred: the model must find them with tool_search.
const deferred = [
  defineTool({
    name: 'lint_rules',
    description: 'Return the repository lint rules every pull request must satisfy.',
    input: z.object({}),
    deferLoading: true,
    execute: async () => ({
      rules: [
        'LINT-1: never iterate an array with `i <= array.length`; use `<` or for..of.',
        'LINT-2: session.user is null for guest checkout; always null-check before dereferencing.',
        'LINT-3: money math must round to cents with Math.round(x * 100) / 100.',
      ],
    }),
  }),
  defineTool({
    name: 'style_guide',
    description: 'Return the repository style guide for reviewers.',
    input: z.object({}),
    deferLoading: true,
    execute: async () => ({ guide: 'Prefer early returns. Name booleans isX/hasX. Keep functions under 30 lines.' }),
  }),
  defineTool({
    name: 'security_checklist',
    description: 'Return the security checklist for reviewing a pull request.',
    input: z.object({}),
    deferLoading: true,
    execute: async () => ({ checklist: ['no secrets in code', 'no eval', 'validate external input'] }),
  }),
  defineTool({
    name: 'suggest_labels',
    description: 'Suggest GitHub labels for the pull request under review.',
    input: z.object({}),
    deferLoading: true,
    execute: async () => ({ labels: ['needs-fix', 'area:checkout'] }),
  }),
];

const reviewChecklist = defineSkill({
  name: 'pr-review-checklist',
  description: 'The checklist this repo uses when reviewing a pull request.',
  content: [
    '# PR review checklist',
    '1. Read the whole diff before judging any hunk.',
    '2. Open every changed file for surrounding context.',
    '3. Flag crashes and correctness bugs as severity critical or high; style as low.',
    '4. Guest checkout means session.user can be null: dereferences must be checked.',
    '5. The review comment must name file and line for every issue.',
  ].join('\n'),
});

const reviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'comment']),
  issues: z.array(
    z.object({
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      file: z.string(),
      // .optional() 400s on OpenAI-strict providers: the SDK sends json_schema
      // strict, which requires every property in `required` (FINDINGS F1).
      line: z.number().int().nullable(),
      message: z.string(),
    })
  ),
  suggestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
type Review = z.infer<typeof reviewSchema>;

/**
 * A reviewer posts once per PR. `post_comment` needs approval, and an approved
 * call can be re-fired (`ctx.resumedAfterApproval`) without counting again;
 * any later, model-emitted call in the same session is denied with a nudge to
 * finish. Also covers the "denied -> model retries" loop.
 */
const postAttempts = new Set<string>();
const oneCommentPerRun = {
  name: 'one-comment-per-run',
  preToolCall(ctx: { toolName: string; sessionId?: string; resumedAfterApproval?: boolean }) {
    if (ctx.toolName !== 'post_comment' || ctx.resumedAfterApproval) return;
    const key = ctx.sessionId ?? 'default';
    if (postAttempts.has(key)) {
      log(auditLog, { kind: 'hook-veto', hook: 'one-comment-per-run', sessionId: key });
      // NOTE: mutating ctx.messages here would break tool_call/tool_result pairing (FINDINGS F4).
      return { deny: 'The review comment for this PR was already posted or rejected. post_comment is unavailable for the rest of this run; your only remaining task is the final JSON review object.' };
    }
    postAttempts.add(key);
  },
};

let phase = 'setup';
const counts: Record<string, number> = {};
const toolsUsed = new Set<string>();
const toolSearchResults: unknown[] = [];
function onEvent(e: AgentEvent): void {
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  log(auditLog, { kind: 'event', phase, event: e });
  switch (e.type) {
    case 'tool.start': {
      toolsUsed.add(e.toolName);
      console.log(`   tool.start ${e.toolName} ${short(e.args)}`);
      break;
    }
    case 'tool.done': {
      if (e.toolName === 'tool_search') toolSearchResults.push(e.result);
      console.log(`   tool.done ${e.toolName} (${e.durationMs}ms) ${short(e.result, 180)}`);
      break;
    }
    case 'tool.error': console.log(`   tool.error ${e.toolName}: ${short(e.error.message, 200)}`); break;
    case 'approval.requested': console.log(`   approval.requested ${e.toolName} id=${e.approvalId}`); break;
    case 'permission.decision': console.log(`   permission ${e.toolName} -> ${e.decision}`); break;
    case 'step.done': console.log(`   step.done ${e.finishReason} usage=${short(e.usage)}`); break;
    case 'provider.retry': console.log(`   provider.retry ${e.attempt}: ${short(e.error.message, 120)}`); break;
    case 'error': console.log(`   ERROR ${e.error.name}: ${short(e.error.message, 200)}`); break;
    case 'run.done': console.log(`   run.done ${e.finishReason}`); break;
  }
}

const agent = createAgent({
  name: 'repo-maintainer',
  model: LIVE_MODEL,
  instructions: [
    'You are repo-maintainer, a pull-request review bot. The workspace holds the repo checked out at the PR head, plus the PR diff file.',
    'Each input is either a GitHub webhook JSON payload (a pull_request for PR number N reviews `pr-N.diff` at the workspace root) or a direct instruction naming the diff file. If the named diff file does not exist, review the newest *.diff in the workspace.',
    'Workflow, in order:',
    '1. Load the "pr-review-checklist" skill with load_skill and follow it.',
    '2. Read the diff file, then read every changed source file once with read_file. The files are small: do NOT grep for keywords.',
    '3. Call tool_search at most twice — you only need the repository lint rules tool; run it and apply the rules to the diff. Everything else you need is already loaded: do not search for more tools.',
    '4. Write a markdown review (verdict, one bullet per issue with file:line, suggestions) and call post_comment with it.',
    '5. Finish with only the structured JSON review.',
    'post_comment is a write: it pauses for human approval. Call it exactly once per review. Whether it is approved, rejected or already posted, afterwards finish immediately with the JSON review.',
    'Budget: at most 12 tool calls for the whole review. Never repeat a call that already succeeded.',
    'Verdicts: a crash or correctness bug in the diff => request_changes; only nits => comment; clean => approve.',
  ].join('\n'),
  output: reviewSchema,
  tools: [...createFsTools(workspace, { readOnly: true }), postComment, ...deferred],
  skills: [reviewChecklist],
  toolSearch: { thresholdPercent: 0, maxResults: 3 }, // force deferral so tool_search must be used
  hooks: [oneCommentPerRun],
  maxSteps,
  onEvent,
});

// ---------------------------------------------------------------- channels
const GH_SECRET = 'gh-webhook-secret-audit';
const PR_SECRET = 'pr-hook-secret-audit';

/** Records every comment the GitHub channel "posts" (no real token needed). */
const ghPosted: Array<{ url: string; body: string }> = [];
const fakeGhFetch: typeof fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { body?: string };
  ghPosted.push({ url: String(input), body: body.body ?? '' });
  log(httpLog, { kind: 'github-api-post', url: String(input) });
  return new Response('{"id": 1}', { status: 201, headers: { 'content-type': 'application/json' } });
};

const ghChannel = githubChannel({
  webhookSecret: GH_SECRET,
  botName: 'repo-maintainer',
  token: 'ghp_mock-token',
  fetch: fakeGhFetch,
  onError: (error, ctx) => log(auditLog, { kind: 'channel-error', channel: ctx.channel, stage: ctx.stage, error: String(error) }),
});

/** A GitHub-flavored webhook intake: `X-Hub-Signature-256` HMAC over the raw body. */
const prChannel = webhookChannel({
  name: 'github-pr',
  auth: { type: 'hmac', secret: PR_SECRET, header: 'x-hub-signature-256' },
  principal: (body) => {
    const sender = (body as { sender?: { login?: unknown } } | undefined)?.sender?.login;
    return typeof sender === 'string' ? { id: sender, type: 'user', authenticator: 'github' } : undefined;
  },
});

const channels = mountChannels(agent, [ghChannel, prChannel], {
  onError: (error, ctx) => log(auditLog, { kind: 'mount-error', channel: ctx.channel, stage: ctx.stage, error: String(error) }),
});

const server = http.createServer((req, res) => {
  void channels(req, res).then((handled) => {
    log(httpLog, { kind: 'response', method: req.method, url: req.url, status: res.statusCode, handled });
    if (!handled) res.writeHead(404).end('not found');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
console.log(`workspace: ${repoDir}\nrun dir:  ${runDir}\nserver:   http://127.0.0.1:${port}  (POST /channels/github, /channels/github-pr)\nmodel:    ${LIVE_MODEL}\n`);

// ------------------------------------------------------------------ http helpers
function sign(raw: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}
async function post(pathName: string, raw: string, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* leave as text */ }
  log(httpLog, { kind: 'client', url: pathName, status: res.status, response: short(text, 400) });
  return { status: res.status, json };
}
const githubPost = (pathName: string, payload: unknown, secret: string, event: string, sig?: string) =>
  post(pathName, JSON.stringify(payload), { 'x-hub-signature-256': sig ?? sign(JSON.stringify(payload), secret), 'x-github-event': event });

async function waitFor(desc: string, cond: () => boolean, timeoutMs = 240_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`   (timed out waiting for ${desc})`);
  return false;
}

// ------------------------------------------------------------------ payloads
const prOpened = {
  action: 'opened',
  number: 42,
  repository: { name: 'cart-service', full_name: 'acme/cart-service', owner: { login: 'acme' }, default_branch: 'main' },
  pull_request: {
    number: 42,
    title: 'Apply stacked coupons and greet the customer',
    body: 'Replaces applyCoupon with a coupon list and adds a checkout greeting.',
    user: { login: 'dev-alice', type: 'User' },
    head: { ref: 'feat/coupons', sha: '8b04e2d' },
    base: { ref: 'main', sha: '3f21a9c' },
    changed_files: 3,
    additions: 30,
    deletions: 8,
  },
  sender: { login: 'dev-alice', type: 'User' },
};

const results: Array<[string, boolean, string]> = [];
const check = (label: string, ok: boolean, detail: string) => {
  results.push([label, ok, detail]);
  report(label, ok, detail);
};

// ====================================================== Phase A: signatures
phase = 'A-signatures';
console.log('== Phase A: X-Hub-Signature-256 verification');
{
  // A1: githubChannel, correctly signed pull_request.opened -> verified, acked 200, no turn (event not a comment)
  const before = ghPosted.length;
  const ok = await githubPost('/channels/github', prOpened, GH_SECRET, 'pull_request');
  check('A1 githubChannel accepts valid signature', ok.status === 200, `status=${ok.status} body=${short(ok.json)}`);

  // A2: bad signature -> 401
  const bad = await post('/channels/github', JSON.stringify(prOpened), {
    'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    'x-github-event': 'pull_request',
  });
  check('A2 githubChannel rejects bad signature', bad.status === 401, `status=${bad.status}`);

  // A3: missing signature -> 401
  const missing = await post('/channels/github', JSON.stringify(prOpened), { 'x-github-event': 'pull_request' });
  check('A3 githubChannel rejects missing signature', missing.status === 401, `status=${missing.status}`);

  // A4: tampered body (signed A, sent B) -> 401
  const tampered = { ...prOpened, pull_request: { ...prOpened.pull_request, title: 'tampered' } };
  const forged = await post('/channels/github', JSON.stringify(tampered), {
    'x-hub-signature-256': sign(JSON.stringify(prOpened), GH_SECRET),
    'x-github-event': 'pull_request',
  });
  check('A4 githubChannel rejects tampered body', forged.status === 401, `status=${forged.status}`);

  // A5: webhookChannel (github-pr) bad signature -> 401
  const badHook = await post('/channels/github-pr', JSON.stringify(prOpened), {
    'x-hub-signature-256': 'sha256=' + 'f'.repeat(64),
    'x-github-event': 'pull_request',
  });
  check('A5 webhookChannel rejects bad signature', badHook.status === 401, `status=${badHook.status}`);
  void before;
}

// ====================================================== Phase B: live review
phase = 'B-review';
console.log('\n== Phase B: pull_request.opened -> live review -> approval gate -> post');
{
  const res = await githubPost('/channels/github-pr', prOpened, PR_SECRET, 'pull_request');
  const first = res.json as { finishReason?: string; approvalId?: string; text?: string; object?: Review };
  log(auditLog, { kind: 'webhook-first-result', status: res.status, result: res.json });

  const paused = res.status === 200 && first.finishReason === 'awaiting-approval' && typeof first.approvalId === 'string';
  check('B1 webhook turn paused for post_comment approval', paused, `status=${res.status} finishReason=${first.finishReason} approvalId=${first.approvalId}`);

  if (paused) {
    const approve = await post(`/channels/github-pr/approvals/${first.approvalId}`, JSON.stringify({ approved: true, note: 'maintainer approved' }), {
      'x-hub-signature-256': sign(JSON.stringify({ approved: true, note: 'maintainer approved' }), PR_SECRET),
    });
    const cont = approve.json as { finishReason?: string; object?: Review; text?: string; outputError?: unknown };
    log(auditLog, { kind: 'approval-continuation', status: approve.status, result: approve.json });
    const comments = readdirSync(runDir).filter((f) => f.startsWith('review-comment-'));
    check('B2 approval continuation completed', approve.status === 200 && cont.finishReason === 'stop', `status=${approve.status} finishReason=${cont.finishReason} outputError=${short(cont.outputError)}`);
    check('B3 post_comment wrote review-comment.json', comments.length >= 1, comments.join(',') || 'none');
    const review = cont.object;
    check('B4 structured output parsed (result.object)', Boolean(review && review.verdict), `verdict=${review?.verdict} issues=${review?.issues?.length} confidence=${review?.confidence}`);
    if (review) {
      const flagsBug = review.issues.some((i) => /cart\.js/.test(i.file) && /coupon|length|bound|undefined|off.by.one|index/i.test(i.message))
        || review.issues.some((i) => /greet|checkout/.test(i.file) && /null|undefined|guest|email/i.test(i.message));
      check('B5 review flags the planted bug(s)', review.verdict === 'request_changes' && flagsBug, `verdict=${review.verdict} issues=${review.issues.map((i) => `${i.severity}:${i.file}`).join('|')}`);
    }
  }

  check('B6 tool_search used for deferred tools', toolsUsed.has('tool_search'), [...toolsUsed].join(','));
  check('B7 a deferred tool was loaded and called', deferred.some((t) => toolsUsed.has(t.name)), [...toolsUsed].filter((n) => deferred.some((t) => t.name === n)).join(',') || 'none');
  check('B8 skill loaded via load_skill', toolsUsed.has('load_skill'), [...toolsUsed].join(','));
}

// ====================================================== Phase C: deny path
if (!arg('--skip-deny')) {
  phase = 'C-deny';
  console.log('\n== Phase C: second PR event -> post_comment DENIED -> no comment file');
  const before = commentSeq;
  const res = await githubPost(
    '/channels/github-pr',
    { ...prOpened, number: 43, pull_request: { ...prOpened.pull_request, number: 43, title: 'Punctuate the greeting' } },
    PR_SECRET,
    'pull_request'
  );
  const first = res.json as { finishReason?: string; approvalId?: string };
  if (res.status === 200 && first.finishReason === 'awaiting-approval' && first.approvalId) {
    const denyBody = JSON.stringify({ approved: false, note: 'do not post this review' });
    const deny = await post(`/channels/github-pr/approvals/${first.approvalId}`, denyBody, { 'x-hub-signature-256': sign(denyBody, PR_SECRET) });
    const cont = deny.json as { finishReason?: string };
    check('C1 denied approval resumes and finishes', deny.status === 200 && (cont.finishReason === 'stop' || cont.finishReason === 'max-steps'), `status=${deny.status} finishReason=${cont.finishReason}`);
    check('C2 denied post_comment did not write', commentSeq === before, `commentsWritten=${commentSeq - before}`);
  } else {
    check('C1 second webhook run reached the approval pause', false, `status=${res.status} finishReason=${first.finishReason}`);
  }
}

// ============================================= Phase D: githubChannel end-to-end
if (!arg('--skip-github')) {
  phase = 'D-github-channel';
  console.log('\n== Phase D: @mention issue_comment -> approval prompt comment -> /approve -> posted review');
  const mention = {
    action: 'created',
    repository: { name: 'cart-service', owner: { login: 'acme' } },
    issue: { number: 42, pull_request: {} },
    comment: { id: 9001, body: '@repo-maintainer review the PR diff pr-42.diff', author_association: 'MEMBER', user: { login: 'dev-alice', type: 'User' } },
    sender: { login: 'dev-alice' },
    installation: { id: 1 },
  };
  const ack = await githubPost('/channels/github', mention, GH_SECRET, 'issue_comment');
  check('D1 issue_comment webhook acknowledged', ack.status === 200, `status=${ack.status} body=${short(ack.json)}`);

  const prompted = await waitFor('approval prompt comment', () => ghPosted.some((p) => /\/approve [A-Za-z0-9_-]+/.test(p.body)));
  check('D2 approval prompt posted as PR comment', prompted, `comments=${ghPosted.length}`);

  if (prompted) {
    const id = /\/approve ([A-Za-z0-9_-]+)/.exec(ghPosted.map((p) => p.body).join('\n'))?.[1] ?? '';
    const approveCmd = {
      action: 'created',
      repository: { name: 'cart-service', owner: { login: 'acme' } },
      issue: { number: 42, pull_request: {} },
      comment: { id: 9002, body: `/approve ${id}`, author_association: 'OWNER', user: { login: 'dev-bob', type: 'User' } },
      sender: { login: 'dev-bob' },
      installation: { id: 1 },
    };
    const ack2 = await githubPost('/channels/github', approveCmd, GH_SECRET, 'issue_comment');
    check('D3 /approve comment acknowledged', ack2.status === 200, `status=${ack2.status}`);
    const finished = await waitFor('final review comment', () => ghPosted.some((p) => !/\/approve|wants to run|Approved by/.test(p.body)));
    const decisionPosted = ghPosted.some((p) => /Approved by @dev-bob/.test(p.body));
    check('D4 /approve resolved the pause (decision + final reply posted)', decisionPosted && finished, `comments=${ghPosted.length} decisionPosted=${decisionPosted}`);
    const finalComment = ghPosted.find((p) => !/\/approve|wants to run|Approved by/.test(p.body));
    if (finalComment) log(auditLog, { kind: 'github-final-comment', body: finalComment.body });
  }
}

// ------------------------------------------------------------------ verdict
server.close();
console.log('\n== Summary');
console.log('event counts:', JSON.stringify(counts));
console.log('tools used:', [...toolsUsed].join(', '));
console.log('tool_search results:', short(toolSearchResults, 500));
writeFileSync(
  path.join(runDir, 'summary.json'),
  JSON.stringify({ runId: RUN_ID, results, counts, toolsUsed: [...toolsUsed], toolSearchResults, ghPosted }, null, 2)
);
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map(([l]) => l).join('; ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
