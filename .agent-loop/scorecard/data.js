window.SCORECARD = {
 "date": "2026-10-02",
 "iterations": 18,
 "prsMerged": 111,
 "differentiatorsShipped": 8,
 "lintWarnings": 0,
 "tests": "2,955",
 "matrix": [
  [
   "Durability / resume",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "Durable stores (SQLite / file / KV)",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Sandboxing",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "Workspace fs + shell tools",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Compaction",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Subagents",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Background / resumable subagents",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Remote subagents",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Approvals / HITL",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "Agent asks the user a question",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Steering (mid-run input)",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Cancellation",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Memory (cross-session)",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Sessions (multi-turn)",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Skills (SKILL.md)",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "AGENTS.md loading",
   "ok",
   "warn",
   "ok",
   ""
  ],
  [
   "Evals",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Eval against deployed URL",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Test utils (mock model, record/replay)",
   "ok",
   "warn",
   "bad",
   ""
  ],
  [
   "Tracing / OTel GenAI",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Metrics / trace viewer",
   "warn",
   "ok",
   "bad",
   "metrics shipped (D48); a trace viewer is not ticketed"
  ],
  [
   "Multi-provider",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Fallbacks / retry policy",
   "ok",
   "warn",
   "warn",
   ""
  ],
  [
   "Structured output",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Multimodal input",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Reasoning control / events",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "MCP client",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "MCP server",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Typed event stream",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "UI bindings React / Vue / Svelte",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "AI SDK UI stream",
   "ok",
   "warn",
   "ok",
   ""
  ],
  [
   "CLI scaffolding",
   "warn",
   "ok",
   "bad",
   "owner publishes to npm"
  ],
  [
   "Dev TUI / REPL",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "Visual studio / debugger",
   "ok",
   "bad",
   "bad",
   ""
  ],
  [
   "Channels (Slack, Discord, ...)",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Schedules",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Deploy story",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Edge runtime (Workers)",
   "ok",
   "bad",
   "bad",
   ""
  ],
  [
   "Budgets / limits",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "Guardrails (input / output)",
   "ok",
   "warn",
   "bad",
   ""
  ],
  [
   "Permissions policy",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "Credential brokering",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Dynamic config",
   "ok",
   "ok",
   "warn",
   ""
  ],
  [
   "Hot reload",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Registry / extensions",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "ACP",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Code-first authoring",
   "ok",
   "warn",
   "ok",
   ""
  ],
  [
   "Directory authoring",
   "ok",
   "ok",
   "bad",
   ""
  ],
  [
   "Agent-readable docs",
   "ok",
   "ok",
   "ok",
   ""
  ],
  [
   "Published on npm",
   "bad",
   "ok",
   "ok",
   "owner action; smoke-tested tarball ready (D49)"
  ],
  [
   "Current ai major",
   "ok",
   "ok",
   "ok",
   ""
  ]
 ],
 "differentiators": [
  [
   "Shipped",
   "Host-agnostic durable sessions in one option",
   "W9 #89, D30 #94: sessions checkpoint every step, resume in any process, one <code>store</code> for sessions, checkpoints and approvals (memory, SQLite, file, KV)."
  ],
  [
   "Shipped",
   "Record/replay as the eval substrate",
   "D46 #96: <code>loushy eval --record / --replay / --drift</code> with cassettes per case and trajectory drift in the JUnit report. Neither competitor has it."
  ],
  [
   "Shipped",
   "OTel GenAI metrics plus cost on any backend",
   "D48 #95: <code>gen_ai.client.token.usage</code>, <code>operation.duration</code>, <code>loushy.cost_usd</code> on spans."
  ],
  [
   "Shipped",
   "Agent Forge time-travel",
   "D43 #98, D44 #104, D45 #112/#113: checkpoint history, fork from step N with an edited tool result, side-by-side trajectories in the Forge History tab."
  ],
  [
   "Shipped",
   "Edge-native durable agents",
   "D51 #125: the Cloudflare Worker target serves sessions over KV, SSE streaming and bearer auth with the same routes as the node server. Worker cron schedules (P9) are still open."
  ],
  [
   "Shipped",
   "Trajectory evals that run anywhere",
   "D46 #96 + D47 #131: the same eval file gates CI in-process and smoke-tests a deployment with <code>loushy eval --url</code>."
  ],
  [
   "Shipped",
   "Reachable from everything",
   "One agent definition is served as an MCP server with annotations (Z5.2), over ACP to editors (Z6 #157), through the HTTP session API on node and Workers, as a remote sub-agent (Y7), through Slack and Discord channels (P5, P6), and from a Next.js route with useChat (P1 #154, P4 #155)."
  ],
  [
   "Shipped",
   "Both authoring modes with hot reload",
   "Code-first and directory authoring with <code>loushy dev</code> hot reload and the <code>loushy chat</code> REPL. Directories carry tools, sub-agents, schedules, channels and memory, and <code>loushy build</code> deploys them (P8.2 #156)."
  ]
 ],
 "done": {
  "U · Correctness": [
   [
    "U7-U9",
    "Durable execution gaps: approval mid-batch, resume with new input, checkpoint after each model turn",
    68
   ],
   [
    "U14",
    "One structured tool-error shape on every failure path",
    93
   ],
   [
    "U15",
    "Real tool execute context (toolCallId, messages, abortSignal), sandbox path included",
    99
   ],
   [
    "U17",
    "Sandboxed HTTP honors cancellation",
    72
   ],
   [
    "U19",
    "Hitting maxSteps yields finishReason max-steps",
    83
   ],
   [
    "U22",
    "Resumed sub-agent that pauses again keeps the session awaiting approval",
    77
   ],
   [
    "HEALTH",
    "No node:crypto import in toolRunContext; Worker bundle loadable",
    107
   ],
   [
    "HEALTH",
    "loushy chat with piped input no longer fails on Node 26 (readline closed)",
    129
   ],
   [
    "HEALTH",
    "Agent Forge client typecheck fixed (approval node reuses the spec policy type)",
    135
   ],
   [
    "U21",
    "Every loushy command parses flags with one strict parseArgs helper",
    137
   ],
   [
    "U23",
    "Docker sandbox stops the container when the run is cancelled",
    163
   ],
   [
    "HEALTH",
    "Agent Forge typechecks include the optional-peer type stubs",
    164
   ]
  ],
  "V · Run loop": [
   [
    "V4",
    "Structured output: output schema, typed result.object, one repair step",
    90
   ],
   [
    "V6",
    "Budgets: maxTokens, maxCostUsd, maxDurationMs, maxSteps on runs and sessions",
    118
   ],
   [
    "V7.1",
    "Provider retry policy and model fallback wrappers",
    74
   ],
   [
    "V7.2",
    "createAgent retry and fallbackModels with typed provider.retry/fallback events",
    86
   ],
   [
    "V8",
    "session.stream()",
    78
   ],
   [
    "V9",
    "Queued follow-up input: run.enqueue and session turnPolicy queue",
    122
   ],
   [
    "V10",
    "Steering: run.steer() aborts the in-flight model call and continues with the new input",
    128
   ],
   [
    "V11",
    "Message.content accepts text, image and file parts",
    106
   ],
   [
    "V12",
    "agent.send(), session.send(), evals and the React hook accept content parts",
    109
   ],
   [
    "V15",
    "Per-run dynamic config: model, instructions and tools as functions of the run",
    139
   ],
   [
    "V14",
    "The continuation after an approval or answer streams (streamResolve, streamAnswer)",
    148
   ],
   [
    "V13",
    "reasoning option and reasoning events; sessionId on the tool execute context",
    176
   ],
   [
    "V4.2",
    "Structured output: typed session.send() object, sub-agent output schemas, either zod major",
    177
   ]
  ],
  "W · Context and memory": [
   [
    "W2",
    "Compaction: prune old tool results behind a pluggable strategy",
    80
   ],
   [
    "W3",
    "Summarize and two-phase compaction with pinned messages",
    84
   ],
   [
    "W3.2",
    "compaction.start/done events and createAgent({ compaction, hooks })",
    102
   ],
   [
    "W6",
    "defineMemory: scoped memory slots with recall and remember/recall tools",
    117
   ],
   [
    "W9",
    "Sessions checkpoint every step and resume a crashed turn",
    89
   ],
   [
    "W6.2",
    "sqliteMemory: memory slots stored in the SQLite store",
    136
   ],
   [
    "W6.3",
    "Agent directories load memory/*.ts slots",
    147
   ],
   [
    "W8",
    "session.compact() and session.clear(); /compact and /clear in loushy chat",
    151
   ],
   [
    "W9.2",
    "Checkpoints carry an agent fingerprint: resuming with a changed agent warns or refuses",
    165
   ]
  ],
  "X · Tools, permissions, hooks": [
   [
    "X2",
    "Declarative permission policies with an audit log",
    105
   ],
   [
    "X4",
    "Input, output and tool guardrails with finishReason guardrail and four built-ins",
    121
   ],
   [
    "X5",
    "spec.policy is enforced: approval and guardrails compiled from the spec file",
    124
   ],
   [
    "X9",
    "Built-in ask_question tool pausing durably until a human answers",
    111
   ],
   [
    "X10",
    "In-memory approval store (inside D21)",
    75
   ],
   [
    "X11",
    "Sandboxed commands get an allowlisted environment; Docker sandbox network policy",
    143
   ],
   [
    "X12",
    "Credential broker: a host-side proxy adds auth for allowed hosts",
    149
   ],
   [
    "X8",
    "needsApproval can approve, deny with a reason or ask; always(), never(), once()",
    153
   ],
   [
    "X3",
    "Hooks can deny a tool call, replace its result or modify its input",
    158
   ],
   [
    "X12.2",
    "Docker sandbox egress goes through the credential broker: network allowlists are enforced",
    168
   ]
  ],
  "Y · Sub-agents": [
   [
    "Y4",
    "Background sub-agents: agent_status, agent_await, agent_cancel, maxConcurrent",
    91
   ],
   [
    "Y4.2",
    "Background children cancelled or awaited when the lead run ends",
    92
   ],
   [
    "Y7",
    "remoteAgent(): a deployed agent used as a sub-agent over the session API",
    132
   ],
   [
    "Y6",
    "The task tool can continue a sub-agent: new, resume and fork modes",
    170
   ],
   [
    "Y7.3",
    "Remote sub-agent approvals pause the lead run; remote output objects pass through",
    179
   ]
  ],
  "Z · MCP": [
   [
    "Z4",
    "connectMcp() and createAgent({ mcpServers })",
    100
   ],
   [
    "Z5",
    "MCP annotations set approval defaults",
    115
   ],
   [
    "Z5.2",
    "serveMcp advertises readOnlyHint and destructiveHint; read-only built-ins annotated",
    142
   ],
   [
    "Z6",
    "loushy acp: serve an agent to editors over the Agent Client Protocol",
    157
   ]
  ],
  "D · DX, CLI, packaging": [
   [
    "D2",
    "Every SDK error has a stable code, a fix hint and a docs link",
    101
   ],
   [
    "D14",
    "Deployed node server: sessions, SSE streaming and bearer auth",
    119
   ],
   [
    "D15",
    "useLoushyAgent React hook over the typed event stream",
    85
   ],
   [
    "D20",
    "mcpServers is a validated AgentSpec field",
    73
   ],
   [
    "D21",
    "createAgent agents can pause for approval and resume",
    75
   ],
   [
    "D22",
    "Tools carry their own inputSchema and execute; defineTool no longer wraps ai.tool()",
    79
   ],
   [
    "D23",
    "ToolExecutionContext replaces ai ToolExecutionOptions in public types",
    103
   ],
   [
    "D24",
    "Small built-ins defined with defineTool",
    108
   ],
   [
    "D25",
    "github and jira tools defined with defineTool; src/tools has no ai import",
    114
   ],
   [
    "D26",
    "ai v6/v7 adapter for generate(), tested on real ai@7",
    123
   ],
   [
    "D27",
    "ai v6/v7 adapter for stream()",
    127
   ],
   [
    "D28a",
    "SDK source type-checks against ai v4 and ai v7; CI job for the v7 typecheck",
    134
   ],
   [
    "D30",
    "createAgent({ store }) wires sessions, checkpoints and approvals",
    94
   ],
   [
    "D31",
    "loushy dev serves agent directories, TS agents and specs with hot reload",
    110
   ],
   [
    "D32",
    "loushy dev: session per tab, SSE events, approval and question buttons",
    116
   ],
   [
    "D33",
    "loushy chat terminal REPL with approval and question prompts",
    120
   ],
   [
    "D34",
    "AgentType optional and deprecated",
    76
   ],
   [
    "D34.2",
    "Apps, examples and tests stop calling setType()",
    97
   ],
   [
    "D35",
    "Remove flows-ai converters and the nanoid dependency",
    82
   ],
   [
    "D36",
    "Remove unused SaaS-era utilities",
    87
   ],
   [
    "D40",
    "dockerode, MCP SDK and prompts become optional peers",
    88
   ],
   [
    "D43",
    "Stores keep a bounded checkpoint history per session",
    98
   ],
   [
    "D44",
    "AgentExecutor.fork() creates a runnable session from a historical checkpoint",
    104
   ],
   [
    "D45.1",
    "Agent Forge time-travel API",
    112
   ],
   [
    "D45.2",
    "Agent Forge History tab: step list, edit-and-replay, side-by-side",
    113
   ],
   [
    "D46",
    "loushy eval records cassettes, replays them in CI and reports drift",
    96
   ],
   [
    "D47",
    "loushy eval --url runs the same eval file against a deployed agent",
    131
   ],
   [
    "D48",
    "OpenTelemetry GenAI metrics and a loushy.cost_usd span attribute",
    95
   ],
   [
    "D51",
    "Cloudflare Worker target: sessions over KV, SSE streaming and bearer auth",
    125
   ],
   [
    "D52",
    "README revamp: 805 to 257 lines, seven new docs pages (owner request)",
    81
   ],
   [
    "D28b",
    "Test suite passes with ai v4 or ai v7 installed; the ai-7 CI job runs vitest",
    140
   ],
   [
    "D28c",
    "Cloudflare Worker bundle builds with ai v7 installed",
    145
   ],
   [
    "D53",
    "One session-API client behind remoteAgent() and remoteTarget()",
    146
   ],
   [
    "D32.2",
    "Approval continuations stream over the session API, the dev chat and the UI bindings",
    152
   ],
   [
    "D43.2",
    "Checkpoint history for the KV store and the Agent Forge file store",
    159
   ],
   [
    "D28d",
    "Peer ranges accept ai v4, v6 and v7; hints, doctor and scaffold follow the installed major",
    160
   ],
   [
    "D50",
    "loushy add: install items from a JSON registry, showing their permission manifest first",
    161
   ],
   [
    "D28f",
    "OpenRouter on ai v6/v7; Ollama base URL fixed; provider contract tests on both ai majors",
    167
   ],
   [
    "D38",
    "Unwired memory/context/retry modules, data and templates removed; /testing is test utilities only",
    169
   ],
   [
    "D42",
    "Package entries share one copy of each module; dist 25.2 MB to 8.8 MB",
    171
   ],
   [
    "D46.2",
    "Eval cassettes record and replay at the model-call step; more plain Errors get codes",
    172
   ],
   [
    "D29",
    "zod 3 or zod 4 for tool schemas, structured output and spec validation",
    174
   ],
   [
    "D49",
    "Publish readiness: pack-and-install smoke test in CI; docs say how to install today",
    175
   ],
   [
    "D2.3",
    "Remaining user-reachable plain Errors carry SDK error codes; vitest crash explained",
    178
   ],
   [
    "D41",
    "One event system: AgentEvent listeners; the old onEvent API is a deprecated adapter",
    180
   ],
   [
    "D16",
    "ESLint ratchet: 345 warnings to 0, and the warning rules are now errors",
    181
   ]
  ],
  "P · UI bindings, channels, schedules": [
   [
    "P5",
    "Slack channel: a session per thread, in-thread replies, approval buttons",
    133
   ],
   [
    "P7",
    "defineChannel contract with mountChannels, http and webhook channels",
    126
   ],
   [
    "P8",
    "Schedules in agent directories: defineSchedule, startSchedules, node server option",
    130
   ],
   [
    "P2",
    "Vue composable under ./vue; UI core moved to a framework-neutral src/ui",
    138
   ],
   [
    "P3",
    "Svelte store under ./svelte with no svelte dependency",
    141
   ],
   [
    "P7.2",
    "Agent directories load channels/*.ts and the node server mounts them",
    144
   ],
   [
    "P6",
    "Discord channel: slash-command interactions mapped to sessions, with approval buttons",
    150
   ],
   [
    "P1",
    "AI SDK UI stream adapter: useChat renders a Loushy run",
    154
   ],
   [
    "P4",
    "createRouteHandler(agent) for Next.js and other Fetch-style frameworks",
    155
   ],
   [
    "P8.2",
    "loushy build and loushy dev serve agent directories with their schedules and channels",
    156
   ],
   [
    "P9",
    "Cloudflare Worker target runs schedules through cron triggers",
    162
   ],
   [
    "P8.3",
    "Directory builds keep optional peers external; the node target runs spec cron triggers",
    166
   ],
   [
    "P5.2",
    "Slack and Discord: approver allowlists, delivery-error reporting, Slack DMs",
    173
   ]
  ]
 },
 "inFlight": [],
 "inFlightNote": "Every ticket is merged and there are no open pull requests. What is left is listed under Decisions and notes: the owner's publish steps and the known limits that have no ticket.",
 "remaining": {
  "U · Correctness": [],
  "V · Run loop": [],
  "W · Context and memory": [],
  "X · Tools, permissions, hooks": [],
  "Y · Sub-agents": [],
  "Z · MCP": [],
  "D · DX, CLI, packaging": [],
  "P · UI bindings, channels, schedules": []
 },
 "notes": [
  "<strong>The loop is finished.</strong> 111 pull requests merged over 18 iterations, none open. 48 of 51 matrix rows are at parity or better (16 at the start), and all eight differentiators are shipped. Lint warnings went from 433 to 0 and are now enforced as errors; tests went from 1,921 to 2,955.",
  "<strong>Main passes the full local suite</strong> (Windows, Node 26) at the final commit: typecheck, lint with zero warnings, 2,955 tests with coverage, fallow, 171 docs snippets and the four Agent Forge checks, all on the first try. CI was not awaited (owner instruction); it pins Node 22.",
  "<strong>The three rows not at parity:</strong> npm publication is the owner's action; the CLI scaffold cannot be used from npm until then; there is no trace viewer (metrics and cost are shipped).",
  "<strong>Owner actions before publishing</strong> (nothing was changed): publish the SDK before <code>create-loushy-agent</code>; npm 11 needs an explicit <code>--tag</code> for a prerelease; <code>files</code> ships 15 test-only files from <code>src/</code> (about 58 KB), with suggested exclusions in STATE.md; installing straight from GitHub would need a <code>prepare</code> script. <code>npm run pack-smoke</code> checks the packed tarball end to end and passes.",
  "<strong>Open decision:</strong> with an event listener set, <code>send()</code> delivers text as one delta per step, not in chunks. Making it identical to <code>stream()</code> is a small change but altered Agent Forge results when tried.",
  "<strong>What was verified how:</strong> every PR got typecheck and targeted tests after syncing with main, then a full run per group; the last PR got the full run before merging. Docker sandbox features were tested against a Docker fake only (no daemon on the machine). Reasoning option names were checked against the installed provider packages, not live APIs. The suite was also run with ai 7 and with zod 4 installed.",
  "<strong>Breaking or model-visible changes shipped pre-1.0</strong> are all in the CHANGELOG with migration notes. The largest: unwired donor-era modules removed; several exported types tightened from <code>any</code>; secret-free sandbox environments; strict CLI flags; the default channel approver; the old <code>onEvent</code> / <code>ExecutionEvent</code> API deprecated.",
  "<strong>Known limits without tickets:</strong> the registry's permission manifest is shown but not enforced; ACP has no file or terminal methods; a pending <code>ask_question</code> in Slack or Discord is lost on restart; sub-agent fingerprints are stored but not compared on resume; OpenRouter does not return reasoning text; a remote sub-agent's token usage is not added to the lead's totals; Ollama on ai 6/7 is untested. The full list is in STATE.md under \"After the loop\".",
  "<strong>Before another round:</strong> the competitor audit dates from before these 111 PRs (eve 0.69.0, open-harness 0.7.0) and should be re-run. Branches were never deleted (owner instruction)."
 ]
};
