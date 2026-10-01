window.SCORECARD = {
  date: '2026-10-01',
  iterations: 12,
  prsMerged: 65,
  differentiatorsShipped: 6,
  lintWarnings: 399,
  tests: '2,606',

  // [capability, us, eve, oh, flips with, in flight]
  matrix: [
    ['Durability / resume', 'ok', 'ok', 'warn', 'W9.2 fingerprint on resume'],
    ['Durable stores (SQLite / file / KV)', 'ok', 'ok', 'bad', ''],
    ['Sandboxing', 'warn', 'ok', 'warn', 'X11'],
    ['Workspace fs + shell tools', 'ok', 'ok', 'ok', ''],
    ['Compaction', 'ok', 'ok', 'ok', ''],
    ['Subagents', 'ok', 'ok', 'ok', ''],
    ['Background / resumable subagents', 'ok', 'ok', 'ok', 'Y6 resumable children'],
    ['Remote subagents', 'ok', 'ok', 'bad', 'Y7.2 approval proxying'],
    ['Approvals / HITL', 'ok', 'ok', 'warn', 'X8 policy helpers'],
    ['Agent asks the user a question', 'ok', 'ok', 'bad', ''],
    ['Steering (mid-run input)', 'ok', 'ok', 'bad', ''],
    ['Cancellation', 'ok', 'ok', 'ok', ''],
    ['Memory (cross-session)', 'ok', 'ok', 'bad', 'W6.2, W6.3'],
    ['Sessions (multi-turn)', 'ok', 'ok', 'ok', ''],
    ['Skills (SKILL.md)', 'ok', 'ok', 'ok', ''],
    ['AGENTS.md loading', 'ok', 'warn', 'ok', ''],
    ['Evals', 'ok', 'ok', 'bad', ''],
    ['Eval against deployed URL', 'ok', 'ok', 'bad', ''],
    ['Test utils (mock model, record/replay)', 'ok', 'warn', 'bad', ''],
    ['Tracing / OTel GenAI', 'ok', 'ok', 'bad', ''],
    ['Metrics / trace viewer', 'warn', 'ok', 'bad', 'metrics shipped (D48); viewer not ticketed'],
    ['Multi-provider', 'warn', 'ok', 'ok', 'D28b-D28d, D29', 'pend'],
    ['Fallbacks / retry policy', 'ok', 'warn', 'warn', ''],
    ['Structured output', 'ok', 'ok', 'bad', ''],
    ['Multimodal input', 'ok', 'ok', 'ok', ''],
    ['Reasoning control / events', 'bad', 'ok', 'warn', 'V13'],
    ['MCP client', 'ok', 'ok', 'ok', 'Z5.2 server annotations'],
    ['MCP server', 'ok', 'ok', 'bad', ''],
    ['Typed event stream', 'ok', 'ok', 'ok', ''],
    ['UI bindings React / Vue / Svelte', 'warn', 'ok', 'warn', 'P2, P3', 'pend'],
    ['AI SDK UI stream', 'bad', 'warn', 'ok', 'P1'],
    ['CLI scaffolding', 'warn', 'ok', 'bad', 'D49, U20 (publish)'],
    ['Dev TUI / REPL', 'ok', 'ok', 'warn', ''],
    ['Visual studio / debugger', 'ok', 'bad', 'bad', ''],
    ['Channels (Slack, Discord, ...)', 'warn', 'ok', 'bad', 'P6, P7.2, P5.2'],
    ['Schedules', 'warn', 'ok', 'bad', 'P8.2, P9'],
    ['Deploy story', 'ok', 'ok', 'bad', ''],
    ['Edge runtime (Workers)', 'ok', 'bad', 'bad', ''],
    ['Budgets / limits', 'ok', 'ok', 'warn', ''],
    ['Guardrails (input / output)', 'ok', 'warn', 'bad', ''],
    ['Permissions policy', 'ok', 'ok', 'warn', ''],
    ['Credential brokering', 'bad', 'ok', 'bad', 'X11, X12'],
    ['Dynamic config', 'bad', 'ok', 'warn', 'V15', 'pend'],
    ['Hot reload', 'ok', 'ok', 'bad', ''],
    ['Registry / extensions', 'bad', 'ok', 'bad', 'D50'],
    ['ACP', 'bad', 'ok', 'bad', 'Z6'],
    ['Code-first authoring', 'ok', 'warn', 'ok', ''],
    ['Directory authoring', 'ok', 'ok', 'bad', ''],
    ['Agent-readable docs', 'ok', 'ok', 'ok', ''],
    ['Published on npm', 'bad', 'ok', 'ok', 'D49 (owner action)'],
    ['Current ai major', 'bad', 'ok', 'ok', 'D28b-D28d, D29']
  ],

  differentiators: [
    ['Shipped', 'Host-agnostic durable sessions in one option', 'W9 #89, D30 #94: sessions checkpoint every step, resume in any process, one <code>store</code> for sessions, checkpoints and approvals (memory, SQLite, file, KV).'],
    ['Shipped', 'Record/replay as the eval substrate', 'D46 #96: <code>loushy eval --record / --replay / --drift</code> with cassettes per case and trajectory drift in the JUnit report. Neither competitor has it.'],
    ['Shipped', 'OTel GenAI metrics plus cost on any backend', 'D48 #95: <code>gen_ai.client.token.usage</code>, <code>operation.duration</code>, <code>loushy.cost_usd</code> on spans.'],
    ['Shipped', 'Agent Forge time-travel', 'D43 #98, D44 #104, D45 #112/#113: checkpoint history, fork from step N with an edited tool result, side-by-side trajectories in the Forge History tab.'],
    ['Shipped', 'Edge-native durable agents', 'D51 #125: the Cloudflare Worker target serves sessions over KV, SSE streaming and bearer auth with the same routes as the node server. Worker cron schedules (P9) are still open.'],
    ['Shipped', 'Trajectory evals that run anywhere', 'D46 #96 + D47 #131: the same eval file gates CI in-process and smoke-tests a deployment with <code>loushy eval --url</code>.'],
    ['Open', 'Reachable from everything', 'MCP server export, the deployed session API (D14, D51), remote sub-agents (Y7 #132) and channels (P7, Slack P5 #133) are in. ACP (Z6) completes it.'],
    ['Open', 'Both authoring modes with hot reload', 'Code and directory authoring, <code>loushy dev</code> hot reload and the <code>loushy chat</code> REPL are in. Deploying an agent directory (P8.2) is the missing piece.']
  ],

  // [id, title, pr]
  done: {
    'U · Correctness': [
      ['U7-U9', 'Durable execution gaps: approval mid-batch, resume with new input, checkpoint after each model turn', 68],
      ['U14', 'One structured tool-error shape on every failure path', 93],
      ['U15', 'Real tool execute context (toolCallId, messages, abortSignal), sandbox path included', 99],
      ['U17', 'Sandboxed HTTP honors cancellation', 72],
      ['U19', 'Hitting maxSteps yields finishReason max-steps', 83],
      ['U22', 'Resumed sub-agent that pauses again keeps the session awaiting approval', 77],
      ['HEALTH', 'No node:crypto import in toolRunContext; Worker bundle loadable', 107],
      ['HEALTH', 'loushy chat with piped input no longer fails on Node 26 (readline closed)', 129],
      ['HEALTH', 'Agent Forge client typecheck fixed (approval node reuses the spec policy type)', 135]
    ],
    'V · Run loop': [
      ['V4', 'Structured output: output schema, typed result.object, one repair step', 90],
      ['V6', 'Budgets: maxTokens, maxCostUsd, maxDurationMs, maxSteps on runs and sessions', 118],
      ['V7.1', 'Provider retry policy and model fallback wrappers', 74],
      ['V7.2', 'createAgent retry and fallbackModels with typed provider.retry/fallback events', 86],
      ['V8', 'session.stream()', 78],
      ['V9', 'Queued follow-up input: run.enqueue and session turnPolicy queue', 122],
      ['V10', 'Steering: run.steer() aborts the in-flight model call and continues with the new input', 128],
      ['V11', 'Message.content accepts text, image and file parts', 106],
      ['V12', 'agent.send(), session.send(), evals and the React hook accept content parts', 109]
    ],
    'W · Context and memory': [
      ['W2', 'Compaction: prune old tool results behind a pluggable strategy', 80],
      ['W3', 'Summarize and two-phase compaction with pinned messages', 84],
      ['W3.2', 'compaction.start/done events and createAgent({ compaction, hooks })', 102],
      ['W6', 'defineMemory: scoped memory slots with recall and remember/recall tools', 117],
      ['W9', 'Sessions checkpoint every step and resume a crashed turn', 89]
    ],
    'X · Tools, permissions, hooks': [
      ['X2', 'Declarative permission policies with an audit log', 105],
      ['X4', 'Input, output and tool guardrails with finishReason guardrail and four built-ins', 121],
      ['X5', 'spec.policy is enforced: approval and guardrails compiled from the spec file', 124],
      ['X9', 'Built-in ask_question tool pausing durably until a human answers', 111],
      ['X10', 'In-memory approval store (inside D21)', 75]
    ],
    'Y · Sub-agents': [
      ['Y4', 'Background sub-agents: agent_status, agent_await, agent_cancel, maxConcurrent', 91],
      ['Y4.2', 'Background children cancelled or awaited when the lead run ends', 92],
      ['Y7', 'remoteAgent(): a deployed agent used as a sub-agent over the session API', 132]
    ],
    'Z · MCP': [
      ['Z4', 'connectMcp() and createAgent({ mcpServers })', 100],
      ['Z5', 'MCP annotations set approval defaults', 115]
    ],
    'D · DX, CLI, packaging': [
      ['D2', 'Every SDK error has a stable code, a fix hint and a docs link', 101],
      ['D14', 'Deployed node server: sessions, SSE streaming and bearer auth', 119],
      ['D15', 'useLoushyAgent React hook over the typed event stream', 85],
      ['D20', 'mcpServers is a validated AgentSpec field', 73],
      ['D21', 'createAgent agents can pause for approval and resume', 75],
      ['D22', 'Tools carry their own inputSchema and execute; defineTool no longer wraps ai.tool()', 79],
      ['D23', 'ToolExecutionContext replaces ai ToolExecutionOptions in public types', 103],
      ['D24', 'Small built-ins defined with defineTool', 108],
      ['D25', 'github and jira tools defined with defineTool; src/tools has no ai import', 114],
      ['D26', 'ai v6/v7 adapter for generate(), tested on real ai@7', 123],
      ['D27', 'ai v6/v7 adapter for stream()', 127],
      ['D28a', 'SDK source type-checks against ai v4 and ai v7; CI job for the v7 typecheck', 134],
      ['D30', 'createAgent({ store }) wires sessions, checkpoints and approvals', 94],
      ['D31', 'loushy dev serves agent directories, TS agents and specs with hot reload', 110],
      ['D32', 'loushy dev: session per tab, SSE events, approval and question buttons', 116],
      ['D33', 'loushy chat terminal REPL with approval and question prompts', 120],
      ['D34', 'AgentType optional and deprecated', 76],
      ['D34.2', 'Apps, examples and tests stop calling setType()', 97],
      ['D35', 'Remove flows-ai converters and the nanoid dependency', 82],
      ['D36', 'Remove unused SaaS-era utilities', 87],
      ['D40', 'dockerode, MCP SDK and prompts become optional peers', 88],
      ['D43', 'Stores keep a bounded checkpoint history per session', 98],
      ['D44', 'AgentExecutor.fork() creates a runnable session from a historical checkpoint', 104],
      ['D45.1', 'Agent Forge time-travel API', 112],
      ['D45.2', 'Agent Forge History tab: step list, edit-and-replay, side-by-side', 113],
      ['D46', 'loushy eval records cassettes, replays them in CI and reports drift', 96],
      ['D47', 'loushy eval --url runs the same eval file against a deployed agent', 131],
      ['D48', 'OpenTelemetry GenAI metrics and a loushy.cost_usd span attribute', 95],
      ['D51', 'Cloudflare Worker target: sessions over KV, SSE streaming and bearer auth', 125],
      ['D52', 'README revamp: 805 to 257 lines, seven new docs pages (owner request)', 81]
    ],
    'P · UI bindings, channels, schedules': [
      ['P5', 'Slack channel: a session per thread, in-thread replies, approval buttons', 133],
      ['P7', 'defineChannel contract with mountChannels, http and webhook channels', 126],
      ['P8', 'Schedules in agent directories: defineSchedule, startSchedules, node server option', 130]
    ]
  },

  // [id, what the agent is doing, pr number once open]
  inFlight: [
    ['V15', 'Per-run dynamic config: model, instructions and tools as functions of the run.'],
    ['D28b', 'Test suite passes with ai v4 or ai v7 installed; vitest added to the ai-7 CI job.'],
    ['U21', 'CLI flags parsed with node:util parseArgs in every command.'],
    ['W6.2', 'sqliteMemory: memory slots stored in the SQLite store.'],
    ['P2', 'Vue composable over the typed event stream, under a ./vue subpath.']
  ],
  inFlightNote: 'The owner asked for every remaining batch to run without check-ins. Nine more batches are planned after this one; the plan is in STATE.md.',

  // [id, title, deps, planned iteration]
  remaining: {
    'U · Correctness': [
      ['U14.2', 'Cancelled-tool and settled-suspension results use the shared error shape', 'U14', 20],
      ['U20', 'Install and roadmap truth once the package is on npm', '', 21],
      ['U21', 'Robust CLI flag parsing with parseArgs', '', 13],
      ['U23', 'Docker sandbox honors the abort signal', '', 19]
    ],
    'V · Run loop': [
      ['V4.2', 'Sub-agents inherit output schema; typed session.send() object', 'V4', 20],
      ['V13', 'Reasoning effort option and reasoning events', 'D26', 20],
      ['V14', 'Streaming resume after approval', '', 14],
      ['V15', 'Per-run dynamic config (model, instructions, tools as functions)', '', 13]
    ],
    'W · Context and memory': [
      ['W6.2', 'sqliteMemory provider', 'W6', 13],
      ['W6.3', 'loadAgentDir picks up memory/<slot>.ts', 'W6', 16],
      ['W8', 'Manual session.compact() and clear()', '', 15],
      ['W9.2', 'Agent fingerprint on resume (warn or refuse on drift)', '', 17]
    ],
    'X · Tools, permissions, hooks': [
      ['X3', 'Hook outcomes: deny, replace, modify', '', 16],
      ['X8', 'Approval policy helpers on needsApproval (always, never, once)', '', 15],
      ['X11', 'Secret-free sandbox exec and egress allowlist', '', 14],
      ['X12', 'Credential brokering proxy', 'X11', 16]
    ],
    'Y · Sub-agents': [
      ['Y6', 'Resumable sub-agent sessions (new, resume, fork)', '', 18],
      ['Y7.2', 'Proxy a remote approval pause to the lead run; reuse the remote session', 'Y7', 21]
    ],
    'Z · MCP': [
      ['Z5.2', 'serveMcp emits annotations from needsApproval', '', 14],
      ['Z6', 'loushy acp (Agent Client Protocol over stdio)', 'V14', 17]
    ],
    'D · DX, CLI, packaging': [
      ['D2.2', 'Remaining plain Errors get codes (agentRun, tools, cli, workspace, validation)', '', 21],
      ['D16', 'ESLint ratchet: 399 warnings to 0, error severity', 'quiet batch', 22],
      ['D23.2', 'Executor sets sessionId on the execute context', '', 21],
      ['D28b', 'Test suite runs on ai v4 or v7', 'D28a', 13],
      ['D28c', 'Worker bundle builds clean on ai v7', 'D28a', 14],
      ['D28d', 'Widen the ai and @ai-sdk peer ranges; hints, doctor and scaffold follow the installed major', 'D28b, D28c', 15],
      ['D29', 'zod 4 / Standard Schema support', '', 16],
      ['D32.2', 'Stream approval continuations live in the dev chat', 'V14', 17],
      ['D37', 'Templates out of the root entry', '', 17],
      ['D38', 'Remove unwired MemoryManager, ContextBuilder, retry.ts', '', 20],
      ['D39', 'Clean /testing; deprecate data/', '', 19],
      ['D41', 'One event system (retire onEvent/ExecutionEvent)', '', 19],
      ['D42', 'Shared chunks across entries (tsup splitting)', '', 18],
      ['D43.2', 'KV and Forge file store checkpoint history', '', 18],
      ['D46.2', 'Provider-middleware hook for eval cassettes', '', 21],
      ['D49', 'Publish readiness: dry-run publish and pack-install smoke test', 'U20', 22],
      ['D50', 'loushy add from a registry with permission manifests', '', 19],
      ['D53', 'One session-API client shared by remoteAgent and remoteTarget', 'Y7, D47', 15]
    ],
    'P · UI bindings, channels, schedules': [
      ['P1', 'AI SDK UI stream adapter (useChat compatible)', 'D27', 17],
      ['P2', 'Vue composable', '', 13],
      ['P3', 'Svelte store', 'P2', 14],
      ['P4', 'Next.js route helper', 'P1', 18],
      ['P5.2', 'Slack hardening: approver allowlist, delivery-error reporting, DMs', 'P5', 20],
      ['P6', 'Discord channel', 'P7', 16],
      ['P7.2', 'loadAgentDir picks up channels/*.ts', 'P7', 15],
      ['P8.2', 'Node deploy target serves agent directories with their schedules and channels', 'P8', 19],
      ['P9', 'Schedules on deploy targets (Worker cron)', 'P8', 18]
    ]
  },

  notes: [
    '<strong>The loop now runs on the owner\'s Windows machine</strong> (Node 26). The first run there found <code>loushy chat</code> broken for piped input on Node 26 (#129) and the Agent Forge client typecheck red since X5 (#135). Both are fixed; main passes the full local suite.',
    '<strong>D28 was split in four</strong> after a trial install of <code>ai</code> 7: source type-checks (D28a, done), tests on either major (D28b), Worker bundle (D28c), then the peer ranges (D28d). Ollama on <code>ai</code> 7 needs zod 4 (D29).',
    '<strong>Branches are never deleted</strong> (owner instruction). About 100 merged <code>lou-*</code> branches remain on origin.',
    '<strong>CI is not awaited</strong> (owner instruction). Main health is proven by the full local suite; CI pins Node 22.',
    '<strong>Limits left in this iteration\'s features:</strong> any Slack workspace member can click Approve or Deny (P5.2); a remote sub-agent or remote eval that pauses for approval is reported as an error (Y7.2); the generated node deploy target does not yet serve agent directories, so their schedules are not started there (P8.2).',
    '<strong>Jira:</strong> the connected Atlassian site has no <code>LOU</code> project; tickets live in STATE.md.',
    '<strong>Breaking changes shipped pre-1.0</strong> (all in CHANGELOG with migration notes): MCP tools without <code>readOnlyHint</code> ask for approval by default; error codes renamed to <code>LOUSHY_*</code>; tool-error results moved the message into <code>message</code>; five donor-era utilities and the flow converters removed.',
    '<strong>npm publish</strong> is an owner action (D49 prepares it).'
  ]
};
