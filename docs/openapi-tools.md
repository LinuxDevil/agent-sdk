# OpenAPI tools

Most services publish an OpenAPI document and no MCP server. `openApiTools()`
turns that document into one typed tool per API operation, so an agent can call
the API without a hand-written `defineTool()` per endpoint and without the raw
[`http` tool](./tools.md#built-in-tools). Operations that change data ask for
[approval](./approvals.md) by default.

`openApiTools` is exported from `@lousho/build-ai-agent` and
`@lousho/build-ai-agent/tools`. It needs no extra package. The `vendor/` model
prefix chooses the provider; with OpenRouter use `openrouter/<vendor>/<model>`
(e.g. `openrouter/openai/gpt-4o-mini`).

## Quick start

```ts no-run
import { createAgent, openApiTools } from '@lousho/build-ai-agent';

const tools = await openApiTools('https://api.example.com/openapi.json', {
  include: ['getOrder', 'refundOrder'],
  bearerToken: () => process.env.ORDERS_API_TOKEN ?? '',
});

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools });
const paused = await agent.send('Refund order 1042');
// getOrder ran. refundOrder (a POST) is waiting for approval:
// agent.approvals.resolve({ id: paused.approvalId!, approved: true })
```

`openApiTools()` is always async, because the document may be a URL. It returns
an array of tools you pass to `createAgent({ tools })` like any other.

`document` can be a parsed OpenAPI 3.0 or 3.1 object, a JSON or YAML string, or
an https URL (a string or a `URL`). Parsing happens once, inside
`openApiTools()`; a tool's `execute` only builds and sends a request.

## What each tool looks like

| Part | Value |
| ---- | ----- |
| Name | The `operationId`, with characters outside `A-Za-z0-9_-` replaced by `_`. Without an `operationId`: `<method>_<path>` (`GET /orders/{orderId}` becomes `get_orders_orderId`). With `prefix`: `<prefix>__<name>`. At most 64 characters. Two operations with the same name throw a `ConfigurationError` that lists both. |
| Description | The operation's `summary`, then its `description` (cut at 1,000 characters), then the method and path (`GET /orders/{orderId}`). |
| Input | An object with every path, query, header and cookie parameter as a top-level property (required as the document declares), plus `body` for an `application/json` request body. Schemas follow `$ref`s into `components`, including `parameters` and `requestBodies`. OpenAPI 3.0 `nullable` works. A parameter whose name is already taken by another location is named `<location>_<name>`. |
| Result | `{ status, statusText, body }` for every HTTP response, error statuses too, so the model can read a 404 and react. `body` is parsed JSON when the response says JSON, otherwise text, empty as `null`. |
| Errors | A network failure, a timeout and a refused redirect are tool errors. |

`Accept`, `Content-Type` and `Authorization` header parameters are ignored, as
the OpenAPI specification says; use `bearerToken` or `headers` for credentials.

## Options

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `baseUrl` | first `servers` entry | Where requests go. Overrides the document. For a document fetched from a URL, a missing `servers` entry means that URL's origin. |
| `include` | all operations | Operation names (`operationId` or derived name), or a function `(op) => boolean`. Naming an operation the document does not have throws. |
| `exclude` | none | Operation names to leave out. |
| `approval` | `'mutating'` | `'mutating'`, `'always'`, `'never'`, or `(op) => boolean`. |
| `prefix` | none | Prefix for tool names. |
| `headers` | none | Headers sent on every request, or a function called per request. |
| `bearerToken` | none | Shorthand for `Authorization: Bearer <token>`; a function is called per request. |
| `providedArguments` | none | Values your application supplies; see below. |
| `timeoutMs` | `30000` | Per request. |
| `maxResponseChars` | `50000` | The response body is cut at this length, with a note saying how much was left out. |
| `fetch` | global `fetch` | Replaces `fetch` (tests, proxies). |

`op` is `{ name, operationId?, method, path, summary?, tags }`.

## Approval defaults

With `approval: 'mutating'`, GET, HEAD and OPTIONS run, and every other method
asks. Each tool also carries MCP-style annotations: `readOnlyHint: true,
destructiveHint: false` on GET, HEAD and OPTIONS; `readOnlyHint: false` on the
rest, with `destructiveHint: true` for DELETE. Anything that reads annotations treats these tools the way it treats MCP tools.

```ts no-run
import { openApiTools } from '@lousho/build-ai-agent';

declare const spec: object;

// Ask for everything except two reads that are known to be harmless.
const tools = await openApiTools(spec, {
  approval: (op) => !['getOrder', 'listOrders'].includes(op.name),
});
```

## Values your application supplies

`providedArguments` fills parameters the model should not choose, such as a
tenant id. A provided key is removed from the tool's input schema (the model
never sees it) and added to the request. The value can be a function, called per
request with the operation and the tool call id.

```ts no-run
import { openApiTools } from '@lousho/build-ai-agent';

declare const spec: object;
declare const currentTenant: () => string;

const tools = await openApiTools(spec, {
  providedArguments: {
    'X-Tenant-Id': () => currentTenant(),
    accountId: 'acct_123',
  },
});
```

The key is the parameter's name (or `body` for the request body). A key that no
selected operation has throws, so a typo does not silently expose the parameter
to the model.

## Security rules

- **The base URL is yours, not the model's.** The model chooses parameter and
  body values; it never chooses the host. The base URL must be https. Plain
  http is accepted only for `localhost`, `127.0.0.1` and `[::1]`, and a URL with
  a user name or password is refused. The same rule applies to a document URL.
- **Credentials stay out of what the model and your logs see.** Headers and
  tokens are never part of a tool's input schema, its `tool.start` and
  `tool.done` events or the transcript; only the model's own input and the
  response are. A header the model supplies for a declared header parameter
  never replaces `headers` or `bearerToken`.
- **Redirects stay on the base origin.** Requests use manual redirects: at most
  3 are followed, and only to the same origin as the base URL. A redirect to
  another origin is a tool error, so a token never leaves the configured origin.
- **Path values stay in their segment.** Path parameters are percent-encoded
  (`../admin` cannot climb out of its segment), and a value of exactly `.` or
  `..` is refused.
- **No private-address check.** The tools call the base URL you configured. If
  that URL can resolve to an internal address that you do not control, put a
  proxy in front or pass your own `fetch`. The `http` tool's address checks are
  for model-chosen URLs.

## Large APIs

An API with hundreds of operations is hundreds of tools. Give the agent the ones
it needs with `include` or `exclude`, or with a predicate on `op.tags`:

```ts no-run
import { openApiTools } from '@lousho/build-ai-agent';

declare const spec: object;

const tools = await openApiTools(spec, { include: (op) => op.tags.includes('orders') });
```

## Limits

- OpenAPI 3.0 and 3.1 only. A Swagger 2.0 document throws a `ConfigurationError`
  that asks you to convert it first.
- Request bodies must be JSON (`application/json` or `+json`). An operation
  with only a multipart, form or XML body is left out; naming it in `include`
  throws.
- Only the first `servers` entry is used, with variables at their defaults.
  Path-level and operation-level `servers` are ignored.
- Every `$ref` must be local (`#/components/...`); a reference to another file
  or URL throws. Bundle the document first.
- No OAuth flows. `bearerToken` and `headers` cover static and per-request
  credentials.
- Response bodies are read as text, and responses are not streamed.
