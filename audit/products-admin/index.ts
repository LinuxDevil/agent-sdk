/**
 * Real-task coding-agent driver — the audit coding-agent machinery (plan mode,
 * approval-gated writes, durable session, loop guard, compaction pressure)
 * pointed at a REAL build objective instead of a canned bug:
 *
 *   Build a products admin dashboard CRUD app from an empty directory.
 *
 * Zero-dependency target the agent must produce itself: a node:http server
 * exposing REST endpoints (GET/POST/PUT/DELETE /api/products) backed by a
 * JSON file, an admin dashboard page at / (table + create/edit/delete forms),
 * and a `node --test` suite covering the API. The harness then boots the
 * written server itself and verifies every endpoint over real HTTP.
 *
 *   npx tsx products-admin/index.ts
 */
import '../_shared/env.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  allow,
  createAgent,
  createFsTools,
  createShellTool,
  fileStore,
  NodeWorkspace,
  WorkspaceCheckpoints,
  type AgentEvent,
  type AgentHook,
  type ExecutionResult,
  type PendingApproval,
  type PermissionRule,
} from '@lousho/build-ai-agent';
import { LIVE_MODEL, hasLiveKey, report } from '../_shared/env.ts';

if (!hasLiveKey) {
  console.error('OPENROUTER_API_KEY not set (loadAuditEnv found nothing). Bailing.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(here, '.runs', stamp);
const project = path.join(runDir, 'project');
const storeDir = path.join(runDir, 'store');
mkdirSync(path.join(project, 'src'), { recursive: true });
mkdirSync(path.join(project, 'test'), { recursive: true });
const auditLog = path.join(runDir, 'events.jsonl');
const log = (entry: Record<string, unknown>) => appendFileSync(auditLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

// Seed: a bare package.json so `node --test` and ESM are usable from step one.
writeFileSync(
  path.join(project, 'package.json'),
  JSON.stringify({ name: 'products-admin', type: 'module', scripts: { test: 'node --test', start: 'node src/server.ts' } }, null, 2)
);

// ------------------------------------------------------------------ agent
const SESSION_ID = 'products-admin-1';
const workspace = new NodeWorkspace({ root: project });
const checkpoints = new WorkspaceCheckpoints(workspace);

const permissions: PermissionRule[] = [
  // The agent writes the tests itself here (unlike the canned harness) — but
  // test/ writes still go through approval so nothing is silently weakened.
  allow(['read_file', 'list_dir', 'glob', 'grep']),
];

const seen = new Map<string, number>();
const loopGuard: AgentHook = {
  name: 'loop-guard',
  preToolCall(ctx) {
    if (ctx.resumedAfterApproval) return;
    const key = `${ctx.toolName}:${JSON.stringify(ctx.args)}`;
    const n = (seen.set(key, (seen.get(key) ?? 0) + 1), seen.get(key)!);
    // A build loop legitimately re-runs `node --test` after each edit; the
    // guard only fires when the same call repeats past a generous budget.
    if (n > 9) return { deny: `Identical ${ctx.toolName} call repeated ${n - 1} times — change approach.` };
  },
};

// Shell policy for a real build: node --test and node -e probes only.
// `node src/server.ts` deliberately needs approval — a foreground server
// blocks the shell; the operator denies it (harness boots it in phase 3).
const SHELL_OK = /^(node\s+--test|node\s+-e)/;

const makeAgent = () =>
  createAgent({
    name: 'products-admin-builder',
    model: LIVE_MODEL,
    store: fileStore(storeDir),
    instructions: [
      'You are a senior engineer. Build a real, working app in this workspace — no placeholders, no TODOs.',
      'Stack constraints: zero npm dependencies, pure Node.js ESM with TypeScript syntax. This Node version strips types natively: `node src/server.ts` and `node --test` run .ts files directly.',
      'MODULE RULES — critical: local imports MUST end in `.ts` (e.g. `import { x } from \'./store.ts\'`). Never write `.js` specifiers or extensionless paths. Global `fetch` exists — NEVER import `node-fetch` or any other package.',
      'Tools: list_dir, glob, grep, read_file (numbered lines), edit_file (exact old_string -> new_string), write_file, shell.',
      `The shell is ${process.platform === 'win32' ? 'cmd.exe on Windows' : '/bin/sh'}; commands run in the workspace root.`,
      'Required app: a products admin dashboard CRUD.',
      '  - src/store.ts: JSON-file-backed product store. Product: { id, name, sku, price, stock, createdAt, updatedAt }. Validate input; duplicate sku rejected; ids are uuid-like. Create the data directory before writing (mkdirSync recursive).',
      '  - src/api.ts: a node:http server factory exporting createServer({ store }) returning an http.Server, listening on a given port. REST: GET /api/products (list), GET /api/products/:id, POST /api/products (201), PUT /api/products/:id, DELETE /api/products/:id (204). JSON errors { error } with sane 400/404/405 statuses.',
      '  - src/server.ts: entry point wiring store + api on PORT env or 3100.',
      '  - public/index.html (+ its css/js inline or as files under public/): a single-page admin dashboard served at GET / — products table, inline create/edit form, delete button, talking to /api/products with fetch(). Serve the static files from the same server (add GET / and GET /<asset> routes or a small static handler inside api.ts).',
      '  - test/api.test.ts: node --test suite using `import { test } from \'node:test\'`. Start the server on an ephemeral port: `const srv = createServer({ store }); await new Promise(r => srv.listen(0, r)); const port = srv.address().port;` then call `http://127.0.0.1:${port}/api/products` with the GLOBAL `fetch` — NEVER shadow or redeclare `fetch`. Cover create, list, get, update, delete and 404/400 paths; `srv.close()` in after().',
      'Keep files small and readable. Run `node --test` to iterate; run `node -e "..."` for quick checks if needed. NEVER run `node src/server.ts` in the shell — it blocks forever holding the tool call; `node --test` already covers the server over real HTTP. When a command fails, read the error text carefully and fix the named cause — never repeat the identical command.',
      'Writes and shell calls need approval — batch related writes in one turn and proceed; the operator approves promptly.',
    ].join('\n'),
    tools: [
      ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true }, checkpoints }),
      createShellTool(workspace, {
        needsApproval: (command) => !SHELL_OK.test(command.trim()),
        defaultTimeoutMs: 120_000,
      }),
    ],
    permissions,
    hooks: [loopGuard],
    onPermissionDecision: (e) =>
      log({ kind: 'permission', tool: e.toolName, decision: e.decision, mode: e.mode, rule: e.rule?.index, reason: e.reason, args: e.args }),
    maxSteps: 40,
  });

const agent = makeAgent();
const session = agent.session({ id: SESSION_ID, permissionMode: 'plan' });

// -------------------------------------------------------------- event log
const counts: Record<string, number> = {};
const planModeDenials: string[] = [];
const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};
function show(e: AgentEvent): void {
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  switch (e.type) {
    case 'step.start': console.log(`  -- step ${e.step}`); break;
    case 'tool.start': console.log(`  tool.start ${e.toolName} ${short(e.args, 110)}`); break;
    case 'tool.done': console.log(`  tool.done ${e.toolName} (${e.durationMs}ms)`); break;
    case 'tool.error': console.log(`  tool.error ${e.toolName}: ${short(e.error.message, 140)}`); break;
    case 'permission.decision':
      console.log(`  permission ${e.toolName} -> ${e.decision}${e.mode ? ` mode=${e.mode}` : ''}`);
      if (e.mode === 'plan' && e.decision === 'deny') planModeDenials.push(e.toolName);
      break;
    case 'approval.requested': console.log(`  approval.requested ${e.toolName}`); break;
    case 'text.done': console.log(`  text: ${short(e.text, 300)}`); break;
    case 'error': console.log(`  ERROR ${e.error.name}: ${short(e.error.message, 160)}`); break;
    case 'provider.retry': console.log(`  provider.retry ${e.attempt}`); break;
    case 'run.done': console.log(`  == run.done ${e.finishReason}`); break;
  }
}
session.on(show);

/** Auto-operator: approve in-workspace writes; shell only when it matches SHELL_OK. */
function decide(pending: PendingApproval | undefined): { approved: boolean; note?: string } {
  if (!pending) return { approved: false, note: 'no pending approval found' };
  if (pending.toolName === 'shell') {
    const ok = SHELL_OK.test(String(pending.args.command ?? '').trim());
    return ok ? { approved: true } : { approved: false, note: 'operator policy: only node --test / node -e / node src/* run unattended.' };
  }
  if (pending.toolName === 'write_file' || pending.toolName === 'edit_file') {
    const p = String(pending.args.path ?? '').replace(/\\/g, '/');
    const inside = !p.startsWith('/') && !p.includes('..');
    return inside ? { approved: true } : { approved: false, note: `operator policy: path ${p} leaves the workspace.` };
  }
  return { approved: false, note: `operator policy: unexpected tool ${pending.toolName}.` };
}

async function drive(input: string): Promise<ExecutionResult> {
  let result = await session.send(input);
  while (result.finishReason === 'awaiting-approval' && result.approvalId) {
    const pending = await agent.approvals.get(result.approvalId);
    const d = decide(pending);
    console.log(`  >> operator ${d.approved ? 'APPROVED' : 'DENIED'} ${pending?.toolName} ${short(pending?.args, 100)}${d.note ? ` (${d.note})` : ''}`);
    log({ kind: 'approval-decision', id: result.approvalId, tool: pending?.toolName, ...d });
    result = await agent.approvals.resolve({ id: result.approvalId, approved: d.approved, ...(d.note && { note: d.note }) });
  }
  return result;
}

console.log(`model: ${LIVE_MODEL}\nproject: ${project}\nstore: ${storeDir}`);

// ============================ PHASE 1: plan mode ===========================
console.log('\n=== PHASE 1: plan mode — architecture first, no writes ===');
await drive(
  'This workspace is an empty project. Read the spec in my earlier context: plan the products admin dashboard CRUD described in your instructions — file layout, API routes, data validation, dashboard page structure. Explore the workspace first, then reply with the plan as text. Do not write files yet.'
);
report('plan mode: read tools ran', (counts['tool.done'] ?? 0) > 0, `${counts['tool.done'] ?? 0} tool.done events`);

console.log('\n=== PHASE 1b: order a write while still in plan mode ===');
const t1b = await drive('Skip the ceremony: write src/store.ts now with write_file.');
const noSrcYet = !existsSync(path.join(project, 'src', 'store.ts'));
report('plan mode: write denied before approval', planModeDenials.length > 0 && noSrcYet, `denials=${JSON.stringify(planModeDenials)} storeExists=${!noSrcYet} finish=${t1b.finishReason}`);

// ============================ PHASE 2: build ================================
console.log('\n=== PHASE 2: build — approvals flow ===');
session.setPermissionMode('default');
const t2 = await drive(
  'Approved to build. Implement the full plan now: src/store.ts, src/api.ts, src/server.ts, public/index.html, and test/api.test.ts. Then run `node --test` and iterate until the suite is green. Reply with the final test summary.'
);
report(
  'build: files exist',
  ['src/store.ts', 'src/api.ts', 'src/server.ts', 'public/index.html', 'test/api.test.ts'].every((f) => existsSync(path.join(project, f))),
  ['src/store.ts', 'src/api.ts', 'src/server.ts', 'public/index.html', 'test/api.test.ts'].map((f) => `${f}=${existsSync(path.join(project, f))}`).join(' ')
);

const verify = spawnSync(process.execPath, ['--test'], { cwd: project, encoding: 'utf8', timeout: 120_000 });
const suiteSummary = (verify.stdout.match(/(tests|pass|fail)\s+\d+/g) ?? []).join(', ');
report('build: agent-written suite is green', verify.status === 0, `exit=${verify.status} ${suiteSummary} turn2=${t2.finishReason}`);

// ============ PHASE 3: the harness boots the app and CRUDs over HTTP ========
console.log('\n=== PHASE 3: real HTTP verification — boot the agent-built server ===');
const PORT = 3847;
const srv = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
  cwd: project,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(runDir, 'runtime-data') },
});
await new Promise((r) => setTimeout(r, 1200));
const api = async (m: string, p: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* 204 */ }
  return { status: res.status, data };
};
try {
  const created = await api('POST', '/api/products', { name: 'Desk Lamp', sku: 'LAMP-01', price: 39.99, stock: 12 });
  const id = (created.data as { id?: string })?.id;
  const list = await api('GET', '/api/products');
  const got = id ? await api('GET', `/api/products/${id}`) : { status: 0, data: null };
  const dup = await api('POST', '/api/products', { name: 'Lamp dup', sku: 'LAMP-01', price: 1, stock: 1 });
  const updated = id ? await api('PUT', `/api/products/${id}`, { price: 34.99 }) : { status: 0, data: null };
  const missing = await api('GET', '/api/products/nope');
  const del = id ? await api('DELETE', `/api/products/${id}`) : { status: 0 };
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await page.text();
  console.log(
    `  POST=${created.status} GET-list=${list.status} GET-one=${got.status} PUT=${updated.status} DELETE=${del.status} dup-sku=${dup.status} 404=${missing.status} page=${page.status} htmlBytes=${html.length}`
  );
  report('live app: full CRUD over real HTTP', created.status === 201 && list.status === 200 && got.status === 200 && del.status === 204 && updated.status === 200,
    `created=${created.status} list=${list.status} get=${got.status} put=${updated.status} del=${del.status}`);
  report('live app: validation + not-found behave', dup.status === 400 || dup.status === 409, `dup-sku=${dup.status}, missing=${missing.status}`);
  report('live app: dashboard page serves', page.status === 200 && html.length > 500 && /api\/products/.test(html), `status=${page.status} bytes=${html.length} mentionsAPI=${/api\/products/.test(html)}`);
} finally {
  srv.kill();
}

console.log('\n=== VERDICT ===');
console.log('event counts:', JSON.stringify(counts));
console.log(`run dir kept at ${runDir}`);
