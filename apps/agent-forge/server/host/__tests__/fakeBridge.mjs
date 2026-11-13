// Fake `lousho bridge` for bridgeClient tests: NDJSON on stdin/stdout.
// Spawned as `node fakeBridge.mjs`; FAKE_BRIDGE_MODE env selects behaviour:
//   (unset)               answers hello; `run` replies then pushes run.settled;
//                         `shutdown` exits 0; `sleep` never answers;
//                         unknown methods answer LOUSHO_BRIDGE_UNKNOWN_METHOD.
//   crash-after-hello     answers hello, then exits 1 on the next request.
//   unknown-command       prints the old-CLI error to stderr and exits 2.
//   silent                never answers anything.
//   garbage               answers hello, answers requests, and also prints
//                         non-JSON noise lines.
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_BRIDGE_MODE ?? 'ok';
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (mode === 'unknown-command') {
  process.stderr.write("lousho: unknown command 'bridge'.\n");
  process.exit(2);
}
if (mode === 'silent') {
  setInterval(() => {}, 1_000); // stay alive, never answer
}

const hello = {
  sdkVersion: '0.0.0-fake',
  specVersions: [1, 2],
  protocol: 1,
  catalogHash: 'fakehash',
};

let helloDone = false;
if (mode === 'garbage') {
  process.stderr.write('fake bridge stderr noise\n');
  setInterval(() => {
    process.stdout.write('this is not json\n');
    process.stdout.write('{broken\n');
  }, 5).unref();
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = request;
  if (mode === 'silent') return; // alive but never answers
  if (method === 'hello') {
    helloDone = true;
    say({ id, result: hello });
    return;
  }
  if (mode === 'crash-after-hello' && helloDone) {
    process.exit(1);
  }
  if (method === 'shutdown') {
    if (process.env.FAKE_BRIDGE_HANG === 'shutdown') return; // hung child: stop() must escalate to signals
    say({ id, result: { ok: true } });
    process.exit(0);
    return;
  }
  if (method === 'run') {
    const runId = 'run-1';
    say({ id, result: { runId, modelLabel: 'mock/test' } });
    say({ event: 'run.settled', runId, data: { finishReason: 'stop', text: 'done' } });
    return;
  }
  if (method === 'sleep' || (method === 'catalog' && process.env.FAKE_BRIDGE_HANG === 'catalog')) {
    return; // never answered: timeout tests
  }
  if (method === 'catalog') {
    say({ id, result: { tools: [], models: [], guardrails: [], triggers: [] } });
    return;
  }
  say({ id, error: { code: 'LOUSHO_BRIDGE_UNKNOWN_METHOD', message: `unknown method ${method}` } });
});
