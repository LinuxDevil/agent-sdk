# Decisions

`decide()` calls the OpenAI Decisions API (`POST /v1/decisions`): a purpose-built endpoint that evaluates shared input against typed questions and returns calibrated answers roughly 10x faster than a full model turn. It is the fast, deterministic shape for the typed-decision pattern — classify, route, gate, score — without spinning up an agent run.

Public beta: `gpt-6-luna` is the only model the endpoint serves, and the surface may still change. The endpoint is not part of chat completions, so it does not go through `createAgent()` providers or OpenRouter — it needs `OPENAI_API_KEY` (or `apiKey`/`baseURL` for a compatible endpoint).

```ts
import { decide } from '@lousho/build-ai-agent';

const { answers } = await decide({
  input: 'I was charged twice for my order.',
  questions: [
    {
      type: 'choice',
      name: 'route',
      instructions: 'Which team should handle this complaint?',
      choices: [
        { value: 'billing', description: 'Payments, invoices, and refunds.' },
        { value: 'technical', description: 'Problems using the product.' },
        { value: 'other', description: 'Anything else.' },
      ],
    },
  ],
});

const route = answers[0];
if (route.type === 'choice' && route.confidence >= 0.7) {
  console.log(`routing to ${route.choice}`); // routing to billing
}
```

## Question types

```ts no-run
import { decide, type DecisionQuestion } from '@lousho/build-ai-agent';

const questions: DecisionQuestion[] = [
  // predicate: probability 0-1 that a condition holds
  { type: 'predicate', name: 'is_spam', instructions: 'Is this message spam?' },
  // choice: one of a fixed unordered set
  {
    type: 'choice',
    name: 'route',
    instructions: 'Which team?',
    choices: [
      { value: 'billing', description: 'Payments and refunds.' },
      { value: 'shipping', description: 'Delivery and tracking.' },
    ],
  },
  // score: probability-weighted position across ordered levels
  {
    type: 'score',
    name: 'severity',
    instructions: 'How severe is this issue?',
    levels: [
      { label: 'Cosmetic', description: 'Appearance only.' },
      { label: 'Workaround available', description: 'Fails, but another way works.' },
      { label: 'Fully blocked', description: 'Fails with no workaround.' },
    ],
  },
];
```

- **predicate** answers carry `probability` — use a threshold (`probability >= 0.9`) where a wrong "yes" is expensive.
- **choice** answers carry `choice`, per-option `probabilities` and `confidence`. Include a fallback option like `'other'` when your categories don't cover every input.
- **score** answers carry `score` (a weighted index that can fall between levels), per-level `probabilities` and `confidence`. Define levels lowest→highest with distinct criteria.
- Any question can come back `{ type: 'refusal' }` — handle it as your "send to review" path.

Independent questions share one `input` and one request:

```ts no-run
import { decide, type DecisionQuestion } from '@lousho/build-ai-agent';

const questions: DecisionQuestion[] = [
  { type: 'predicate', name: 'is_spam', instructions: 'Is this spam?' },
  {
    type: 'choice',
    name: 'route',
    instructions: 'Which team?',
    choices: [{ value: 'billing' }, { value: 'shipping' }],
  },
];

const userMessage = 'I was charged twice for my order.';
const { answers } = await decide({ input: userMessage, questions });
const byName = Object.fromEntries(answers.map((a) => [a.name, a]));
```

`input` also takes message form with inline base64 images (`{ type: 'input_image', image_url: 'data:...' }`) for visual checks like damage inspection; hosted image URLs and `file_id` are not supported.

## Options

```ts no-run
import { decide } from '@lousho/build-ai-agent';

const result = await decide({
  input: '...',
  questions: [{ type: 'predicate', name: 'relevant', instructions: 'Is this relevant?' }],
  model: 'gpt-6-luna',                    // default; currently the only served model
  apiKey: process.env.OPENAI_API_KEY,     // default: OPENAI_API_KEY
  baseURL: 'https://api.openai.com/v1',   // override for a compatible endpoint
  timeoutMs: 30_000,                      // request timeout; also accepts `signal`
});
```

Failures are `SDKError`s: missing key is `LOUSHO_PROVIDER_MISSING_API_KEY`, a `429` is `LOUSHO_PROVIDER_RATE_LIMITED`, other HTTP or malformed responses are `LOUSHO_PROVIDER_REQUEST_FAILED`, and aborts/timeouts are `LOUSHO_OPERATION_TIMEOUT`.

## When to use what

- **`decide()`** — a typed answer about one input: routing, filtering, severity, confidence gates. Fast and calibrated, but no prose and no tools.
- **[Structured output](structured-output.md)** (`createAgent({ output })`) — when you need your own JSON schema: extracted fields, a written explanation, or an object shaped like your domain. Works on any provider, including strict structured-output endpoints (see [Schema limits](structured-output.md#schema-limits)).
- **[Sub-agents](sub-agents.md)** or [flows](flows.md) — when the decision needs tools or multi-step reasoning before it answers.

The [coding-agent-workflows example](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/coding-agent-workflows) shows the same route/confidence/floor pattern built on `output` schemas — swap its triage step for `decide()` when you are on OpenAI and want the dedicated endpoint. [Prompting techniques](prompting-techniques.md#typed-decisions-system-one-style) places both forms in the wider typed-decision catalog.
