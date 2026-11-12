---
description: Architecture and contracts v0 for Lousho workspaces. A workspace is a folder of pages, harnesses, agent references, a shared policy and a declarative UI, with the files, fields, defaults, path rules, composition rules, error codes and JSON Schemas that exist today in lousho/workspaces.
---

# Workspaces: architecture and contracts (v0)

This page is the one document for the workspace contracts in `lousho/workspaces`. It describes what the code does on `main` today. Where a part is planned and not built, it is marked **P1** (the runtime) or **Later**. The experimental `lousho/workspaces` entry point holds only contracts, validation and pure helpers so far: it reads no files, calls no model and starts no run.

- [Concepts](#concepts)
- [Library, service and clients](#library-service-and-clients)
- [The folder tree](#the-folder-tree)
- [Who owns what](#who-owns-what)
- [The files and their fields](#the-files-and-their-fields)
- [Path bases](#path-bases)
- [Harness composition](#harness-composition)
- [References](#references)
- [Shared context and policy](#shared-context-and-policy)
- [The execution contract](#the-execution-contract)
- [The page UI catalog](#the-page-ui-catalog)
- [Authoring operations](#authoring-operations)
- [Validation and error codes](#validation-and-error-codes)
- [The rules](#the-rules)
- [Lock and pinning](#lock-and-pinning)
- [The runtime pipeline (P1)](#the-runtime-pipeline-p1)
- [JSON Schema export](#json-schema-export)
- [What is deferred](#what-is-deferred)

## Concepts

| Term | Meaning |
| --- | --- |
| Workspace | The unit you create, for example Marketing. A folder with a `workspace.json` that lists its pages. A **project** is the container that holds workspaces in a host's database. |
| Page | One task environment inside a workspace: a `page.json`, a harness, an `agents.json`, an optional UI and its resources. Pages are flat; nested pages are not supported in v1. |
| Harness | How a page performs its task: instructions, audience, platform, input and output schemas, constraints, evaluation and limits. A harness describes; the runtime enforces. |
| Base harness | An optional harness at the workspace level. It is layer 0 under every page. |
| Harness profile | A reusable harness (`id` and `version` required) that pages and other profiles `extends`. |
| Main-agent harness | An optional harness for the main agent: routes, clarifying questions, presentation, limits and what to do when a page fails. |
| Attachment | An agent attached to one page in `agents.json`, with an alias and page-level narrowing. Agents are referenced, never nested. |
| Work type | The page's execution type: `single`, `multi-agent`, `workflow` or `goal-oriented`. It is page configuration, never part of an agent's identity. |
| Page UI | A declarative `ui/page.ui.json` built from a closed component catalog and bound to the harness's input and output schemas. |
| Main agent | An optional agent that reads the user's request and routes it to a page. `mainAgent: null` runs pages directly, for any number of pages. |
| Policy | `shared/policies/policy.json`: what the runtime enforces, under a limit set by the host. |

The names are fixed: schema ids, subpaths and folders say "workspace" (`lousho.workspace/1`, `lousho/workspaces`, `src/workspaces/`).

## Library, service and clients

The core is a library. A service and two clients are planned on top of it.

| Part | Status | What it is |
| --- | --- | --- |
| `lousho/workspaces` | On main | Contracts (zod schemas and types), `validateWorkspace`, `composeHarness`, `narrowPolicy`, `applyOps`, the page UI validator and the execution types. Pure: no file system, no network, no module-level state. |
| `WorkspaceSource` | P1 | The interface the runtime reads a workspace through: a folder, an in-memory tree or a database. |
| Runtime | P1 | `createWorkspaceRuntime(source, options)` loads a workspace, composes harnesses and runs pages. The host injects tools, the policy limit, providers, secrets and stores. |
| Service | P2 | A long-lived Node HTTP and SSE service wraps the runtime. Agents never run in a Next.js route handler. |
| Typed client | P2 | One client for the wire contract. Agent Forge and a host's own Next.js app are two clients of the same service. |

### WorkspaceSource and the virtual file tree

Every contract works on a **file tree**: an object from a path relative to the workspace root to the file's content. A `.json` file's value is parsed JSON or its text; any other file's value is text. This is `WorkspaceTree`, and `validateWorkspace`, `baseHarnessLayer` and `applyOps` all take one.

A database-backed source stores each workspace as such a tree with immutable revisions, so a run is pinned to one revision and every file-oriented rule on this page still holds. Code under `src/workspaces/` reads a workspace only through a source and never calls `node:fs` outside the folder source and the file stores. The test fixtures read folders with `src/workspaces/__fixtures__/readTree.ts`, which is the one place that does.

## The folder tree

```text
<workspace>/
  workspace.json                 lousho.workspace/1
  harness/                       optional base harness (workspace.json "harness" names another folder)
    harness.json                 lousho.harness/1, no id, version or extends
    *.md                         prose listed in its "instructions"
  harness-profiles/              workspace profiles (workspace.json "harnessProfiles")
    <path>/harness.json          a profile; its prose sits beside it
  agents/                        workspace agents, <name>/agent.json (workspace.json "agents")
  workflows/                     <name>/workflow.json (workspace.json "workflows")
  shared/
    instructions/*.md            ordered by file name
    knowledge/  brand/  resources/   referenced as shared:<path>
    skills/<name>/SKILL.md
    memory/*.ts
    policies/policy.json         the only policy file
  main-agent/                    present when mainAgent is not null
    agent.json  instructions.md
    harness/
      main-harness.json          lousho.main-harness/1
      *.md
  pages/<page>/                  one folder per entry of workspace.json "pages"
    page.json                    lousho.page/1
    agents.json                  lousho.agents/1
    harness/harness.json         lousho.harness/1 (page.json harness.overrides names another folder)
    harness/*.md  harness/checks/*.ts
    workflow.json  goal.json     inactive blocks may stay on disk
    ui/page.ui.json              lousho.ui/1
    resources/
    agents/<name>/agent.json     page-local agents
```

Defaults when a manifest names no folder: `harness`, `agents`, `harness-profiles`, `workflows` and `main-agent/harness`. A missing `harness/` folder means there is no base harness. A named folder with no files is an error. Every folder under `pages/` must be listed in `workspace.json`, and every listed page must have a `page.json`.

## Who owns what

| Setting | Owner | Where it lives |
| --- | --- | --- |
| Instructions, skills, tools, memory, default model | The agent | The agent folder (`agent.json`, `instructions.md`, `skills/`) |
| Alias, role, model, limits, `tools.only` | The page, per attachment | `pages/<p>/agents.json` |
| How the task is done: audience, platform, schemas, constraints, evaluation, limits | The harness | Base harness, profiles, page harness |
| Which agents run, in what shape, with what limits | The page | `page.json` `execution` |
| Permissions, tool allowlist, secrets, network hosts, approvals, sandbox | Policy | `shared/policies/policy.json`, under the host's limit |
| The limit on any policy; tools, providers, secrets, stores | The host | Injected into the runtime (P1) |
| What the screen looks like | The page UI | `pages/<p>/ui/page.ui.json` |
| Routing, clarifying, presentation | The main-agent harness | `main-agent/harness/main-harness.json` |

The Studio shows these as two label sets, exported as `AGENT_OWNED` (`instructions`, `skills`, `tools`, `memory`, `default model`) and `PAGE_OWNED` (`as`, `role`, `model`, `limits`, `tools.only`, `harness`). They are display labels, not key paths.

### Where each setting lives

Every setting is customisable; this table shows where.

| Layer | What it sets | Where |
| --- | --- | --- |
| Harness | The task description only: audience, platform, schemas, constraints, evaluation. R13 forbids `model`, `provider`, `tools`, `permissions`, `secrets`, `sandbox`, `approvals`, `network`, `mcpServers` and `hooks` here | Base harness, harness profiles, page harness |
| Agent | Instructions, skills, tools, default model | The agent folder |
| Attachment | `model`, `limits`, `tools.only`, `role` | `pages/<p>/agents.json` |
| Page | Execution type and runner settings (`limits`, `onFailure`, `checkpoint`), `defaults.model`, `models.provider` | `page.json` |
| Workspace | `defaults` (model, limits), `budget`, `improve` (including `proposerModel`), `models.provider` | `workspace.json` |
| Shared policies | Permissions, tool allowlist, secrets, network hosts, approvals, sandbox | `shared/policies/` |
| Host | The policy ceiling, providers, secrets | Injected into the runtime |

## The files and their fields

Every object is strict: an unknown key is an error. Every document starts with a `schema` id.

### workspace.json (`lousho.workspace/1`)

| Field | Type and default |
| --- | --- |
| `id` | kebab-case, required |
| `name`, `description` | non-empty string, required |
| `version` | semver, required |
| `domain` | non-empty string |
| `mainAgent` | `null`, or `{ dir: "./main-agent", inheritsShared?, harness? }`. Required: `null` means pages run directly |
| `harness` | base harness folder, default `harness` |
| `pages` | page folder names in display order, kebab-case, no duplicates, required |
| `agents`, `harnessProfiles`, `workflows` | folders, defaults `agents`, `harness-profiles`, `workflows` |
| `dependencies` | `{ agents?, profiles? }`, ref to version range. Recorded only; nothing checks them in v1 |
| `defaults` | `{ model?, limits?: { maxConcurrentPages?, maxCostUsdPerRun? } }`. `maxConcurrentPages` defaults to 3 |
| `budget` | `{ mode: "shared" or "per-page" }` |
| `improve` | `{ enabled?, healer?: "shared" or "per-page", proposerModel? }`. `enabled` defaults to `true` |
| `models` | `{ provider?: string or null }`. A built-in provider name (for example `pi`) that wraps every page model; see [model precedence](#model-precedence-and-modelsprovider) |

Folder fields are safe relative paths that stay inside the workspace. Two workspace folders may not overlap, and none may point into `pages/` or `shared/policies/` (PRD027).

### page.json (`lousho.page/1`)

| Field | Type and default |
| --- | --- |
| `id`, `name`, `description` | `id` kebab-case; all required. The main agent routes on `description` |
| `domain` | non-empty string |
| `harness` | `{ extends: string[], overrides? }`, required. `extends` is the profile refs; `overrides` is the page harness folder, default `./harness/` |
| `agents` | the attachments file, default `./agents.json` |
| `execution` | required, see below |
| `ui` | the UI file, default `./ui/page.ui.json` |
| `improve` | `{ enabled? }`, overrides the workspace default |
| `platform` | `{ profile?, adapter? }` |
| `defaults` | `{ model? }` |
| `models` | `{ provider?: string or null }`. Overrides the workspace's `models.provider`; `null` opts the page out of the wrapper |
| `runtime` | reserved: only `{ kind: "local" }` is accepted |

Page paths may not start with `pages/` (nested pages, PRD009).

`execution` is `{ type, single?, multiAgent?, workflow?, goal?, limits?, onFailure?, checkpoint? }`:

| Block | Fields |
| --- | --- |
| `single` | `agent`: an alias from `agents.json` |
| `multiAgent` | `lead` and `delegates?`: aliases |
| `workflow` | `workflow`: `./workflow.json` or `workspace:<name>` |
| `goal` | `lead`, `delegates?` and `goal: "./goal.json"` |
| `limits` | `maxDurationMs`, `maxTurns` (positive integers), `maxCostUsd` (positive number) |
| `onFailure` | `return-to-main` (default), `stop` or `ask` |
| `checkpoint` | boolean |

The block named by `type` is required. The other blocks are validated but not run, so a page keeps its other configurations when its type changes (see [type switching](#type-switching)). Aliases are names from `agents.json`, never refs.

### Model precedence and `models.provider`

`resolvePageModel` (exported from `lousho/workspaces`) picks the model a page's agent runs with. The first level that sets a model wins:

1. the attachment's `model` in `agents.json`;
2. the page's `defaults.model`;
3. the agent's own default model;
4. the workspace's `defaults.model`.

It returns `{ model, source }`, where `source` is `attachment`, `page`, `agent`, `workspace` or `none` (no level sets a model), for provenance and the Studio.

Then the provider wrapper applies. The effective provider is the page's `models.provider` when the page sets the key (`null` means no wrapper), otherwise the workspace's `models.provider`. A model `x/y` becomes `<provider>/x/y`, unless it already starts with `<provider>/`, so a model is never wrapped twice. For example, with `models: { "provider": "pi" }` in `workspace.json`, `anthropic/claude-sonnet-5-5` runs as `pi/anthropic/claude-sonnet-5-5`.

The schema checks only the name's format (lowercase letters, digits and dashes, starting with a letter). Whether the provider is registered on this host is a runtime check, since the host injects providers (R17).

The improver is separate (R8): `improve.proposerModel` and any Determinator model are never wrapped by `models.provider`, and never go through `resolvePageModel`.

### harness.json (`lousho.harness/1`)

The same document is used by a page, the base harness and a profile. A profile requires `id` (kebab-case) and `version` (semver). The base harness refuses `id`, `version` and `extends`.

| Field | Meaning |
| --- | --- |
| `extends` | Profile refs, composed in order |
| `instructions` | Prose `.md` files; paths are safe relative paths ending in `.md` |
| `audience` | `{ description, traits? }` |
| `platform` | `{ id, requirements? }`; `requirements` is free-form data |
| `inputs.schema` | A JSON Schema object with `type: "object"`, or a relative path to one |
| `outputs.schema` | A JSON Schema object, or a relative path to one |
| `outputs.artifacts` | `{ name, mediaType, required? }`, unique by `name`. A name is a plain file name that is also a safe artifact URI segment: no URL, `/`, `\`, `:`, markup, name starting with `.`, or control, format or separator character (Cc, Cf, Cs, Zl, Zp), at most 200 characters and 255 UTF-8 bytes. The page UI's `artifact` component uses the same schema |
| `capabilities.require` | Dotted names such as `image.generate`. Requirements, never grants |
| `constraints` | `{ id, text }`, unique by `id` |
| `evaluation` | `{ criteria, threshold? }`. A criterion is `{ id, description, check?, rubric?, weight? }` and needs a `check`, a `rubric` or both. `threshold` is 0 to 1 |
| `runtime.limits` | `maxDurationMs`, `maxTurns`, `maxCostUsd` |
| `runtime.modelHints` | `temperature` (0 to 2) and `reasoning` (`none`, `minimal`, `low`, `medium`, `high`) |
| `context.resources` | Resource paths |

A harness must not carry any of these keys at any depth: `permissions`, `tools`, `secrets`, `sandbox`, `approvals`, `mcpServers`, `hooks`, `model`, `provider`, `network` (R13, PRD001), and `execution`, `workflow`, `goal`, `steps`, `lead`, `delegates` (R18, PRD002). Keys are compared ignoring case, whitespace, `-`, `_` and invisible characters. Property names inside `inputs.schema` and `outputs.schema` are data and are not scanned as keys. A value that is not plain JSON (a class instance, a getter, nesting deeper than 64 levels) is refused.

`hasExecutableCriterion(harness)` is true when at least one criterion has a `check` (R19).

### main-harness.json (`lousho.main-harness/1`)

| Field | Meaning |
| --- | --- |
| `instructions` | Prose files, relative to the main harness folder |
| `routes` | `{ page, when }`. Absent means every page, routed on its description. Each `page` must be listed in `workspace.json` (PRD015) |
| `clarify` | `{ askWhen: string[], runImmediatelyWhen: string[] }` |
| `presentation` | `{ style, followUps, revisions }` |
| `limits.maxConcurrentPages` | Can only tighten the workspace's value. A larger value is clamped and reported as a warning (PRD031) |
| `onPageFailure` | `report`, `retry-once` or `ask` |

The R13 and R18 key rules apply to it too. `MAIN_HARNESS_OPTIONALITY` is the table below.

| Situation | Behaviour |
| --- | --- |
| No main agent | No main harness. Works for any number of pages |
| Main agent, no main harness | Default routing prompt built from the page descriptions |
| Main agent and main harness | The harness drives routing, presentation and follow-ups |

A main harness with `mainAgent: null`, and any `main-agent/` file in that case, is an error (PRD011).

### agents.json (`lousho.agents/1`)

`{ schema, agents: Attachment[] }`. An attachment is `{ as, ref, role?, model?, limits?, tools?: { only? } }`:

- `as`: a kebab-case alias, unique in the file.
- `ref`: an [agent ref](#references).
- `limits`: `maxDurationMs`, `maxTurns`, `maxCostUsd`; they can only tighten the agent's own.
- `tools.only`: narrows the agent's tools. A page can never add tools.
- `permissions`, `secrets`, `instructions` and `add` are agent-owned and are errors in an attachment (R13, PRD005).

## Path bases

One rule: **a file a harness lists resolves from the folder that owns that harness layer**, and a missing file is an error. Paths use forward slashes and may not leave the folder they start from.

| Field | Resolved from |
| --- | --- |
| `workspace.json` `harness`, `agents`, `harnessProfiles`, `workflows`, `mainAgent.harness` | The workspace root |
| `page.json` `agents`, `harness.overrides`, `ui`, `./workflow.json`, `./goal.json` | The page folder |
| Page harness `instructions`, `context.resources`, `evaluation.criteria[].check` when it is a script path (ending `.js`, `.ts`, `.mjs`, `.cjs`, `.mts` or `.cts`), and `inputs.schema` / `outputs.schema` given as a path | The page folder. A page harness in `harness/` lists `harness/task.md`, not `task.md` |
| The same four fields in the base harness | The base harness folder (`harness/` unless `workspace.json` names another), so the base lists `checks/brand-voice-applied.ts` for `harness/checks/brand-voice-applied.ts` |
| The same four fields in a profile | That profile's own folder |
| Main harness `instructions` | The main harness folder |
| `workspace:<name>` workflow | `<workflows>/<name>/workflow.json` |
| `workspace:<name>` agent | `<agents>/<name>/` |
| `local:<name>` agent | `pages/<page>/agents/<name>/` |
| `workspace:<path>` profile | `<harnessProfiles>/<path>/harness.json` |

A listed file that is missing is PRD032 (PRD004 for base-harness prose, PRD011 for main-harness prose). A schema given as a path is read into its layer before composition, so the effective harness and the UI binding check see the schema object, and two pages never resolve one base path to different files. A `global:` profile is resolved from the files the host's `resolveGlobal` returns for it. A check script is only checked for existence, and only a `check` ending in a script extension is a path.

A criterion's `check` names a check in the host's check registry, and the runtime never imports a workspace `.ts` file. Three forms name one: a script path (`harness/checks/script-present.ts`, folder sources only, and the file must exist) names its base name without the extension, `script-present`; a bare name (`script-present`) needs no file; a `builtin:<kind>?<params>` ref is its own name. `checkNameOf(check)` gives the registry name, `checkRegistry(map)` builds a `WorkspaceCheckRegistry` over a plain map, and `resolveCheck(registry, check)` looks a criterion's check up by that name.

## Harness composition

`composeHarness(layers)` is pure. A `HarnessLayer` is `{ source, harness, texts }`: `source` is a ref (`workspace base`, `workspace:platforms/instagram`, `global:audiences/general@1.2.0` or `page`), and `texts` holds the prose of each listed file, keyed by the path as listed.

**Order.** The base harness, then each `extends` ref in order and depth first (a profile's own `extends` come before it), then the page. A profile reached twice is applied once, at its first position. A cycle, more than four levels of `extends`, two layers with one source, or a layer not reached from the base or the page is an error. The `extends` refs of a layer must equal the `source` of another layer exactly, range included.

| Field | Rule |
| --- | --- |
| `instructions` | Concatenated in layer order, each file group under `### From <source>` |
| `audience`, `platform` | Deep merge. The later layer wins per key, and arrays and scalars replace |
| `inputs.schema`, `outputs.schema` | The later layer replaces the whole schema. An object with `"merge": "allOf"` is composed instead: `{ allOf: [earlier, later] }`, with a path written as `{ $ref: path }` |
| `outputs.artifacts` | Union by `name`; the later layer replaces an earlier one with the same name |
| `constraints` | Union by `id`; a later layer replaces the earlier constraint with that id |
| `evaluation.criteria` | Union by `id`, later wins. `threshold` is the latest value set |
| `capabilities.require` | Ordered union |
| `runtime.limits` | The minimum of each limit across layers, so a later layer can only tighten |
| `runtime.modelHints` | Later wins per key |
| `context.resources` | Ordered union |

The result, `EffectiveHarness`, holds `sources`, the composed `instructions`, the merged fields, `provenance` (for each field path, the sources its value came from) and `hash`. The hash is the sha256 of the canonical JSON of the sources, prose and fields, with keys sorted. It does not depend on key order and is stable across runs, so a revision or a span can name the exact harness it ran with. Provenance is not part of the hash.

```ts
import { composeHarness, type HarnessLayer } from 'lousho/workspaces';

const base: HarnessLayer = {
  source: 'workspace base',
  harness: {
    schema: 'lousho.harness/1',
    instructions: ['voice.md'],
    constraints: [{ id: 'tone', text: 'Be warm.' }],
    runtime: { limits: { maxTurns: 20 } },
  },
  texts: { 'voice.md': 'Write in a warm voice.' },
};

const page: HarnessLayer = {
  source: 'page',
  harness: {
    schema: 'lousho.harness/1',
    constraints: [{ id: 'tone', text: 'Be playful.' }],
    runtime: { limits: { maxTurns: 30 } },
  },
  texts: {},
};

const effective = composeHarness([base, page]);
console.log(effective.runtime?.limits?.maxTurns, effective.constraints, effective.hash);
```

Here `maxTurns` stays 20, because a page cannot loosen the base, and the `tone` constraint is the page's.

## References

Agent refs and harness profile refs have different grammars. Do not read one as the other.

| Ref | Form | Resolves to |
| --- | --- | --- |
| Agent, workspace | `workspace:<name>` | `<agents>/<name>/` |
| Agent, page-local | `local:<name>` | `pages/<page>/agents/<name>/` |
| Agent, global | `global:<name>@<range>` | A host-provided agent; the range is `x.y.z`, `^x[.y[.z]]` or `~x[.y[.z]]` |
| Profile, workspace | `workspace:<path>` | `<harnessProfiles>/<path>/harness.json`; the path has lower-case segments separated by `/` |
| Profile, global | `global:<path>@<range>` | The folder the host's `resolveGlobal` returns for the ref |

Agent names are kebab-case. A `workspace:` or `local:` agent ref takes no range. A prefix is required. `parseAgentRef` returns `{ ok: true, ref }` or `{ ok: false, error }` and never throws:

```ts
import { parseAgentRef } from 'lousho/workspaces';

const parsed = parseAgentRef('global:fact-checker@^1.0.0');
if (parsed.ok && parsed.ref.kind === 'global') console.log(parsed.ref.name, parsed.ref.range);
```

`validateWorkspace` finds a missing workspace or local agent folder (PRD020) and a profile it cannot find (PRD024). A `global:` ref is answered only by the host's `resolveGlobal` option. Version ranges are parsed and recorded; nothing is pinned in v1 (see [lock and pinning](#lock-and-pinning)).

### Inheritance

`INHERITANCE_RULES` says how each shared folder reaches pages and the main agent:

| Item | Rule |
| --- | --- |
| Instructions | Shared first, then harness, then the agent. Shared files are ordered by file name in plain code-unit order |
| Skills | Union; a clash is an error unless `override: true` |
| Memory | Shared slots are shared instances, page slots are private |
| Context files | Referenced as `shared:<path>` from `knowledge`, `brand` or `resources`; never merged into a prompt on their own |
| Policies | Apply to every page and to the main agent, and cannot be opted out of |
| Main agent | Gets shared context only if `inheritsShared`, but always gets shared policy |

## Shared context and policy

Shared files sit under fixed patterns: `shared/instructions/<name>.md`, `shared/knowledge/**`, `shared/brand/**`, `shared/resources/**`, `shared/skills/<name>/SKILL.md`, `shared/memory/<name>.ts` and `shared/policies/policy.json`. Policy lives in that one file and nowhere else. Another file under `shared/policies/`, or a policy key (`permissions`, `tools`, `secrets`, `network`, `approvals`, `sandbox`) in any other document, is an error (PRD014).

`policy.json` is `{ permissions, tools: { allow }, secrets, network?, approvals?, sandbox? }`:

- `permissions`: ordered spec v2 permission rules, each with an `id`. The first match decides.
- `tools.allow`: tool names; `*`, or a trailing `*` as in `publish_*`, covers several.
- `secrets`: `{ env: "NAME" }` or `{ secret: "name" }` refs.
- `network.allowHosts`: lower-case host names or `*.example.com`. There is no "any host" form.
- `approvals.require`: tool names that must wait for a human.
- `sandbox.required`: whether code and shell execution must be sandboxed.

### Resolving the shared layer

`resolveSharedContext(workspace, options)` reads a `LoadedWorkspace` and returns `{ instructions, skills, memorySlots, resources }` for one `audience`: a page (`{ page: id }`) or `'main-agent'`. The main agent gets nothing unless `mainAgent.inheritsShared` is true; policy is applied separately.

- Instructions are ordered by file name.
- Skills are the union of `shared/skills/*/SKILL.md` and the `skills` option. Two skills with one name throw `LOUSHO_SKILL_INVALID` naming both files; `override: true` only lets a skill from the `skills` option replace a shared one.
- Memory files are never run by the core, so the host passes `createMemory(file)` to build each slot, and a missing one throws `LOUSHO_MEMORY_INVALID`. Pass one `createSharedContextRun()` per workspace run: every page that passes it gets the same shared slot objects. Page-private memory is the attached agent's own `memory`, not part of the shared layer.
- Files under `shared/knowledge`, `shared/brand` and `shared/resources` come back as frozen handles with a `shared:<path>` ref. A file over `maxResourceBytes` (default 262144) is listed with its size but its text is not inlined.

### How a workspace policy narrows the host's limit

`narrowPolicy(ceiling, workspace)` is pure. It validates both arguments with `workspacePolicySchema` and throws on invalid input, so a typo in the ceiling fails closed. A workspace can only narrow.

| Field | Rule |
| --- | --- |
| `tools.allow` | The intersection. `*` and `name*` in the ceiling cover the workspace names they match, and a workspace pattern keeps the ceiling names it covers. A ceiling that lists nothing grants nothing |
| `network.allowHosts` | The intersection, with `*.host` covering subdomains only, never the apex or a look-alike. A workspace with no `network` inherits the ceiling's hosts. A ceiling with no `network` grants none |
| `secrets` | Only refs present in the ceiling (same `env` or `secret` name), without duplicates |
| `permissions` | `{ ceiling, workspace }`. The ceiling's rules come back unchanged. The workspace's rules keep their `deny` and `ask` rules and lose their `allow` rules. The runtime evaluates each list first-match and decides in the order `deny > ask > none > allow`, where `none` means no rule matched. So a workspace deny or ask holds under a ceiling allow, and a ceiling deny holds under a workspace rule. A ceiling `allow` with no matching workspace rule yields `none`, not `allow`: the tool's own approval applies |
| `approvals.require` | The union of both lists, so it only grows |
| `sandbox.required` | OR of the two. A workspace can turn it on but never off. Absent means `false` |

```ts
import { narrowPolicy, type WorkspacePolicy } from 'lousho/workspaces';

const ceiling: WorkspacePolicy = {
  permissions: [],
  tools: { allow: ['search_*', 'render_video'] },
  secrets: [{ env: 'API_KEY' }],
  network: { allowHosts: ['*.example.com'] },
};

const workspace: WorkspacePolicy = {
  permissions: [],
  tools: { allow: ['search_facts', 'publish'] },
  secrets: [{ env: 'API_KEY' }, { env: 'OTHER_KEY' }],
  network: { allowHosts: ['api.example.com'] },
  sandbox: { required: true },
};

const effective = narrowPolicy(ceiling, workspace);
console.log(effective.tools.allow, effective.secrets, effective.network.allowHosts, effective.sandbox.required);
```

The result keeps `search_facts`, `API_KEY` and `api.example.com`, and turns the sandbox on. `publish` and `OTHER_KEY` are not in the ceiling and are dropped.

### How the runtime enforces the policy

The runtime enforces the narrowed policy. No harness, `page.json` or `agents.json` key can widen it. The host injects its tools as a `HostToolRegistry`: each entry has a `descriptor`, the `secrets` it reads and the `capabilities` it provides. The runtime never imports a workspace `.ts` file, so **a tool file's name is its tool name**: `tools/search_facts.ts` maps to the host tool named `search_facts`. An agent tool with no host tool of that name is left out and reported as a load warning. A Studio `{ file }` tool ref is named by its file stem too, and other tool refs by the name the model sees (`builtin`, `registry`, ...), not their canvas `id`.

A workspace agent is read from its files and nothing in it is run, so settings it would silently drop are refused at load with `LOUSHO_AGENT_DIR_INVALID`, as hooks are: on a Studio spec `mcpServers`, `guardrails`, `subagents`, `handoffs`, `triggers`, `flow`, `permissionMode`, `approvalTtlMs`, `codeMode`, `toolSearch`, `output` and `promptRef`; on a folder agent `permissionMode`, `projectInstructions`, `approvalTtlMs`, `output` and the `subagents/`, `schedules/` and `channels/` folders. A memory slot's name is its file name.

| What | Rule |
| --- | --- |
| Tools | `effectiveToolset(policy, attachment, agentTools, registry)` keeps `agentTools ∩ registry ∩ policy.tools.allow ∩ (attachment.tools.only ?? all)`. `tools.only` is a list of literal names and can only narrow |
| Permissions | `effectivePermissions(policy, agentPerms)` checks the ceiling, workspace and agent lists first-match each and decides `deny > ask > none > allow`. Only an agent `allow` can allow. An agent `allow`, a name or a pattern such as `*`, that a policy `deny` or `ask` shadows is a load warning |
| Secrets | A tool gets the secrets it declares that the policy also lists, and nothing else. A page has no secret store |
| Network and sandbox | The policy's values. An agent's own `network.allowHosts` can only narrow them, and its `sandbox.required` can only turn sandboxing on |
| Approvals | A tool in `approvals.require` asks for approval every time, in an agent run and in a workflow `toolCall` step, whatever an `allow` rule or the permission mode says. So does a Studio tool ref with `approval: 'always'`. A host tool's own `needsApproval` ask is kept the same way: an agent `allow` never lifts it. A deny still denies |
| Capabilities | `pagePolicy()` fails page start with `LOUSHO_WORKSPACE_CAPABILITY_MISSING` (`capability-missing`) when `capabilities.require` names something no tool in the page's effective toolsets provides. A tool that a ceiling or workspace rule denies outright provides nothing. A capability never grants a tool |

`agentPolicyOptions(policy, { attachment, agent }, registry)` returns the `createAgent` `tools` and `permissions` for one attachment, or for the main agent when `attachment` is left out. It also returns a `toolRegistry` for a workflow's `toolCall` steps, which pass `flowToolGate`, plus `secrets` by tool, `network`, `sandbox` and `warnings`. It is the only code path under `src/workspaces/runtime` that builds a toolset. `attachmentAgent()` is the only place the page runtime builds an agent: it takes those options, passes every tool through the host's `bindTool(descriptor, scope)` with the tool's `secrets`, `network.allowHosts` and `sandbox.required`, and the host enforces them.

```ts
import { narrowPolicy, pagePolicy, type HostToolRegistry } from 'lousho/workspaces';
import { defineTool } from 'lousho';
import { z } from 'zod';

const registry: HostToolRegistry = {
  render_video: {
    descriptor: defineTool({ name: 'render_video', description: 'Render a video', input: z.object({ script: z.string() }), execute: () => 'video.mp4' }),
    capabilities: ['video.render'],
  },
};

const policy = narrowPolicy(
  { permissions: [], tools: { allow: ['*'] }, secrets: [] },
  { permissions: [], tools: { allow: ['render_video'] }, secrets: [], approvals: { require: ['render_video'] } }
);

const page = pagePolicy(
  policy,
  {
    capabilities: ['video.render'],
    attachments: [{ alias: 'video', agentOwned: { tools: ['render_video'] }, pageOwned: {} }],
  },
  registry
);
console.log(Object.keys(page.attachments.video.tools), page.warnings);
```

## The execution contract

Every engine implements one interface, so the main agent, the wire contract and the page UI do not care which type a page runs under. These are plain JSON types.

```ts
import type { PageEngine, PageInput, PageResult, PageRunContext } from 'lousho/workspaces';

async function runEngine(engine: PageEngine, input: PageInput, ctx: PageRunContext): Promise<PageResult> {
  ctx.emit({ type: 'progress', message: `running ${input.pageId} as ${engine.type}` });
  return engine.run(input, ctx);
}
```

| Type | Fields |
| --- | --- |
| `PageInput` | `pageId`, `task`, `inputs?`, `revise?: { runId, instruction }`, `parentRunId?` |
| `PageResult` | `status`, `output?`, `artifacts`, `summary` (what the main agent sees), `usage`, `runId`, `traceId?`, `checkpointId?`, `error?: { kind, message }` |
| `PageRunContext` | `runId`, `signal`, `limits`, `labels`, `artifacts` (an `ArtifactSink`), `emit(event)` |
| `PageEngine` | `type: WorkType` and `run(input, ctx)` |
| `PageUsage` | `inputTokens`, `outputTokens`, `totalTokens`, `costUsd?`, `costPartial?`, `modelCalls?` |

`status` is one of `ok`, `failed`, `timed-out`, `cancelled` or `needs-approval`; `PAGE_RUN_STATUSES` lists them and `isTerminalStatus` is false only for `needs-approval`. `error.kind` is one of `invalid-input`, `invalid-output`, `budget`, `timeout`, `cancelled`, `stalled`, `engine`, or another string.

An artifact is stored through `ArtifactSink.put(name, data, mediaType)`, which returns an `ArtifactRef`: `{ name, mediaType, uri, bytes, sha256 }`. Its `uri` is `artifact://<workspace>/<runId>/<name>` with the run id and name percent-encoded. `formatArtifactUri` and `parseArtifactUri` are inverses. The workspace is kebab-case; the run id and name are 1 to 255 UTF-8 bytes, may not start with `.`, and may not contain `/`, `\`, or control, format or separator characters. `parseArtifactUri` decodes each segment once and returns `undefined` for anything that does not parse.

### The span vocabulary

Every engine emits the same labels, and attribution reads only these, never the engine:

- `PageStepLabels`: `page`, `attachment`, `harnessHash`, `executionType`, `stepKind`, `stepIndex` and, for a delegate, `parentStepIndex`.
- `PageRunLabels`: `page`, `harnessHash` and `executionType`, carried by the `started` event.
- `StepKind`, listed in `STEP_KINDS`: `single`, `workflow-step`, `delegate`, `goal-iteration`.
- `WORK_TYPE_STEP_KINDS` names the kinds each type may emit: `single` emits `single`; `multi-agent` emits `single` and `delegate`; `workflow` emits `workflow-step` and `delegate`; `goal-oriented` emits `goal-iteration` and `delegate`.
- `PageRunEvent` is one of `started`, `step` (with `phase: "start"` or `"done"`), `artifact`, `approval` (`approvalId`, `kind`, `expiresAt?`), `progress` (`message`, `fraction?`) or `finished` (`status`).

### Running a page

`runPage(workspace, input, ctx)` runs one page of a loaded workspace:

1. It throws `LOUSHO_WORKSPACE_PAGE_UNKNOWN` for a page id the workspace does not list. It validates `input.inputs` against the effective `inputs.schema` with `checkPageInputs`, the same check the page UI runs in the browser (`lousho/workspaces/client`). On a problem it returns `failed` with `error.kind: 'invalid-input'` and every field path (`inputs.report: ...`) before any model call.
2. It picks the engine for `execution.type` from `ctx.engines`, by default `ENGINES`. `engineFor(type)` throws `LOUSHO_WORKSPACE_ENGINE_UNKNOWN` when the registry has none; `ENGINES` has `single` today.
3. It resolves the attachments, applies the policy with `pagePolicy()` (each warning prints as a `[lousho] runPage:` console warning), and runs the engine with the run id as its session id, `ctx.signal`, and the page's `execution.limits`.
4. It validates `output` against `outputs.schema` and checks that every artifact marked `required` was stored.
5. On an invalid output it gives the engine one repair turn, a revise of the same run whose instruction starts `your output failed:`, then returns `failed` with `invalid-output`.

An empty `task` becomes the page UI's `title`, else the page id. A page gets only the task, its inputs and, for a revise, the earlier run's `PageResult` (`ctx.prior`). It never sees the main agent's conversation or another page's transcript.

The `single` engine runs the page's one attachment in its own session, with structured output (the `output` mode of an AgentSpec) when the harness has an output schema. That mode also makes one repair call inside a turn when a reply does not parse or does not match the output schema, so the runtime's repair turn comes after it. The session carries the page's limits, so turns, cost and duration count across both turns, and running out of `maxDurationMs` ends the run `timed-out` with `error.kind: 'timeout'`.

The host injects a `PageRuntimeHost`: `tools` (a `HostToolRegistry`), the policy `ceiling`, `bindTool`, and optionally `provider(model)`, `exporter`, `globalAgents` and `globalProfiles`. Every agent the runtime builds gets its step's labels from `labelsFor()` as `lousho.*` attributes on its `invoke_agent` span (`labelAttributes()`, with the workspace id, the harness part hash and a `global:` agent's version and sha256), and the engine puts the same labels on its `step` events.

### Type switching

Changing `execution.type` changes only that key (the `set_execution_type` operation). The other blocks stay in `page.json`, and `workflow.json` and `goal.json` stay on disk, so switching back loses nothing. Inactive blocks are still validated: an alias that `agents.json` does not define is an error even in a block that does not run (PRD018). Engine framing, the short text an engine adds after the agent's role, belongs to the engine, not the harness, and sits outside the harness hash (P1). Because a harness never names the process (R18), the same harness works under all four types.

## The page UI catalog

A page UI is `{ schema: "lousho.ui/1", title?, layout }`. The catalog is closed (R15). A component is `{ type, ... }`, and every field is strict.

| Group | Types |
| --- | --- |
| Layout | `stack`, `row`, `section`, `card` (each with `children`), `tabs` (with `tabs: [{ label, children }]`) |
| Inputs | `text`, `textarea`, `number`, `select`, `radio`, `toggle`, `slider`, `file`, `schemaForm` |
| Actions | `runButton`, `cancelButton`, `reviseBox` |
| Outputs | `text`, `markdown`, `json`, `table`, `artifact`, `artifactGallery` |
| Status | `runStatus`, `progress`, `traceLink` |
| Revisions | `versionList`, `compare` |

Every component may have `label` and `visibleWhen`. An input has `bind: inputs.<field>…`, an output has `source: outputs.<field>…`, and `artifact` has `artifact: <name>`. A `text` component takes exactly one of `bind` (an input) or `source` (an output). `number` and `slider` take `min`, `max` and `step`; `select` and `radio` take `options: [{ value, label? }]`; `file` takes `accept`, a list of media types. `visibleWhen` is a safe expression that may read only `inputs`, `outputs` and `status`.

Text is plain: `label`, `title`, `placeholder` and option labels are 1 to 500 characters with no HTML or markup and no URL, after decoding entities and normalising. An `artifact` component's name must pass the same artifact name rule as a harness (no URL, path, markup or leading dot) and must be declared in `outputs.artifacts` (UI006). These keys are refused at any depth: `html`, `innerHTML`, `outerHTML`, `dangerouslySetInnerHTML`, `script`, `eval`, `href`, `src`, `srcset`, `srcdoc`, `url`, `style`, `css`, `className`, `class`, `__proto__`, `constructor`, `prototype`, any `on*` handler key (R15), and the R13 harness keys. The schema blocklist is defence in depth: the renderer must draw model text as text nodes.

### Binding a UI to a harness

`validateUiBindings(ui, harness)` checks a UI against a harness's `inputs` and `outputs` (use the composed harness) and returns problems with these codes:

| Code | Meaning |
| --- | --- |
| UI001 | A `bind` names a field the input schema does not have |
| UI002 | The component does not fit the field's type (for example `number` on a string) |
| UI003 | `select` or `radio` on a field without an `enum`, or an option outside the `enum` |
| UI004 | A `source` names a field the output schema does not have |
| UI005 | The output component does not fit the field's type |
| UI006 | An `artifact` names an artifact `outputs.artifacts` does not declare |
| UI007 | A required input with no default is bound by no component |
| UI008 | A schema is a file path or has a `$ref`, so the check could not run; resolve it first |

`validateWorkspace` reports each of these as PRD012 and resolves a schema path against the page folder first.

```ts
import { pageUiSchema, validateUiBindings } from 'lousho/workspaces';

const ui = pageUiSchema.parse({
  schema: 'lousho.ui/1',
  layout: {
    type: 'stack',
    children: [
      { type: 'textarea', bind: 'inputs.topic' },
      { type: 'runButton' },
      { type: 'markdown', source: 'outputs.summary' },
    ],
  },
});

const problems = validateUiBindings(ui, {
  inputs: { schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
  outputs: { schema: { type: 'object', properties: { summary: { type: 'string' } } } },
});
console.log(problems);
```

No catalog component binds an array input; only `schemaForm` on the parent can.

## Authoring operations

Chat and forms edit a workspace through one closed set of typed operations, not raw files. `applyOps(tree, ops, { validate })` is pure: it applies the operations in order to a tree, writes only known files at their default paths (never `shared/policies/**`), and runs `validate` on the result. With any problem it returns the original tree and every problem, each naming its operation index. `validate` is required so callers pass `validateWorkspace`.

The operations are: `create_workspace`, `set_workspace_field`, `create_page`, `remove_page`, `reorder_pages`, `set_page_field`, `set_harness_field`, `write_harness_prose`, `add_extends`, `remove_extends`, `set_base_harness_field`, `set_main_harness_field`, `add_criterion`, `remove_criterion`, `create_agent`, `write_agent_prose`, `attach_agent`, `detach_agent`, `set_attachment_field`, `set_execution_type`, `set_execution_config`, `write_workflow`, `write_goal`, `write_page_ui`, `reset_page_ui` and `write_shared_instruction`. `AUTHORING_OP_NAMES` lists them. Policy, secrets, the tool catalog and global agents are not in the set. Each operation validates against the file's own schema, so a forbidden key is refused here as well.

```ts
import { applyOps, validateWorkspace } from 'lousho/workspaces';

const result = applyOps(
  {},
  [
    { op: 'create_workspace', id: 'notes', name: 'Notes', description: 'Meeting notes.' },
    { op: 'create_page', page: 'summarize', name: 'Summarize', description: 'Summarize a meeting.', execution: { type: 'single', single: { agent: 'writer' } } },
  ],
  { validate: validateWorkspace },
);
console.log(result.problems.map((problem) => `${problem.opIndex ?? '-'} ${problem.path}: ${problem.message}`));
```

This batch is refused: the page names the alias `writer` that `agents.json` does not define (PRD018) and has no executable criterion (PRD017). Both problems name operation 1, and the returned tree is the empty input. Adding `attach_agent` and `add_criterion` operations to the batch fixes them.

`opFiles(op, tree)` returns the files an operation would write or delete. `authoringOpSchema` is the zod schema and `authoringOpJsonSchema()` its JSON Schema, from which the chat agent's tools are generated.

## Validation and error codes

`validateWorkspace(tree, options?)` checks a whole tree across files. It never throws for invalid input and never touches the file system. It returns problems `{ severity, code, file, path, message }` in a stable order. Only `error` makes a workspace invalid; `warning` and `info` do not. `options.resolveGlobal(ref)` answers `global:` refs with that folder's files, and `options.mode: "strict"` adds only an `info` note in v1.

```ts
import { validateWorkspace } from 'lousho/workspaces';

const problems = validateWorkspace({
  'workspace.json': JSON.stringify({
    schema: 'lousho.workspace/1',
    id: 'notes',
    name: 'Notes',
    version: '0.1.0',
    description: 'Meeting notes.',
    mainAgent: null,
    pages: ['summarize'],
  }),
});
for (const problem of problems) console.log(problem.severity, problem.code, problem.file, problem.message);
```

This prints PRD022, because `summarize` is listed but has no folder.

| Code | Severity | Meaning |
| --- | --- | --- |
| PRD001 | error | A harness carries an R13 key (a grant) |
| PRD002 | error | A harness carries an R18 key (the process) |
| PRD003 | error | A harness or profile is invalid |
| PRD004 | error | The base harness is invalid, its prose is missing, or its folder has files but no `harness.json` |
| PRD005 | error | An attachment carries an R13 key |
| PRD006 | error | `agents.json` is invalid |
| PRD007 | error | An agent ref is malformed |
| PRD008 | error | `page.json` is invalid |
| PRD009 | error | Nested pages |
| PRD010 | error | The page UI is invalid |
| PRD011 | error | The main harness is invalid, a main-harness prose file is missing, or a main harness or `main-agent/` file exists with `mainAgent: null` |
| PRD012 | error | A UI binding problem; the message starts with the UI code |
| PRD013 | error | The harness layers do not compose (a cycle, too deep, or a missing source) |
| PRD014 | error | Policy outside `shared/policies/policy.json` (R13) |
| PRD015 | error | A main-harness route names a page `workspace.json` does not list |
| PRD016 | error | A goal check names a criterion no layer defines |
| PRD017 | error, or warning when improvement is off | No criterion has an executable `check` (R19) |
| PRD018 | error | An `execution` alias is not in `agents.json`, in any block |
| PRD019 | error | A workflow step names an alias `agents.json` does not define |
| PRD020 | error | A `workspace:` or `local:` agent ref has no folder |
| PRD021 | error | A page folder is not listed in `workspace.json` |
| PRD022 | error | A listed page has no folder or no `page.json` |
| PRD023 | error | `workspace.json` is missing or invalid |
| PRD024 | error | An `extends` ref is not a profile ref, or the profile is not found |
| PRD025 | warning | `capabilities.require` cannot be checked until P1 defines the effective toolset |
| PRD026 | error | The policy file is invalid |
| PRD027 | error | Workspace folders overlap, or one points into `pages/` or `shared/policies/` |
| PRD028 | error | A `.json` file is not valid JSON |
| PRD029 | info | Strict mode in v1: there is no lock, so no lock or pin check ran |
| PRD030 | error | A workflow or goal file is missing or invalid |
| PRD031 | warning | A main-harness limit was clamped to the workspace's |
| PRD032 | error | A file a page harness or profile lists as prose, or any harness layer lists as a check script, resource or schema, is missing |

A refused tree is reported once: when a manifest is unreadable or its folders overlap, the cross-file checks do not run.

## The rules

These are the rules the contracts enforce. The number is the rule's id in the project plan.

- **R10, the edit surface.** An editor, healer or apply path may change only prose files: page, base and main-agent harness `.md` files named in `instructions`, an agent's `instructions.md` and `skills/<name>/SKILL.md` inside the workspace, `harness-profiles/**/*.md`, `shared/instructions/*.md` and `main-agent/instructions.md`. It never changes a `.json` file, schemas, evaluation criteria, goal checks, `extends`, tools, models or budgets, so an agent can never lower its own bar. It never changes a global agent or profile. Structure changes only through typed operations, which land in a draft. The writer that enforces this is P1/P2.
- **R13, harnesses describe and the runtime enforces.** No harness, profile, `page.json`, `agents.json` or page UI key can grant a tool, permission, secret, network host, sandbox setting or approval exemption. Permissions come from `shared/policies/` and the agent's own tools, intersected, and a page can only narrow them. A forbidden key is an error, not a warning.
- **R15, declarative UI.** A page UI uses only the catalog: no HTML, script, remote URL or `eval`. Model text renders as plain text.
- **R17, the host injects, the core never reaches out.** Code under `src/workspaces/` reads a workspace only through a `WorkspaceSource`, runs and stores only through injected stores, calls no `node:fs` outside the folder source and file stores, and holds no module-level mutable state.
- **R18, the harness says what, never how.** A harness never names the execution process; `execution`, `workflow`, `goal`, `steps`, `lead` and `delegates` are errors in harness files. Prose cannot be validated, so authoring help tells people to describe the task and the result, not the order of work.
- **R19, every improvable page has a check.** A page with improvement on (the default) needs at least one criterion with an executable `check`, not only a `rubric`. Rubrics never gate an edit on their own.

## Lock and pinning

**Later.** A `workspace.lock.json` that pins profile and agent versions, and strict-mode checks that read it, are not part of v1. Today `dependencies` and `@<range>` suffixes are parsed, validated for shape and recorded, and nothing resolves or pins a version. `validateWorkspace` in strict mode returns one `info` problem (PRD029) so a caller can see that no lock check ran. When the lock returns, its entries become rows of the virtual tree.

## The runtime pipeline (P1)

The page runtime is built (`runPage`, above); the main agent and router are not built yet. The planned order, from a request to a reply, is: load the workspace from a source, resolve agents and harness layers, resolve shared context, apply policy under the host's limit, run the main agent (when there is one), route to a page, compose the page's harness, run the page's engine, validate the output against `outputs.schema`, and return a `PageResult` to the main agent. Everything the pipeline reads is defined on this page, and a new field lands in its schema, its JSON Schema and this page in the same change as its first reader.

## JSON Schema export

The structure of each file is exported as JSON Schema (draft 7) in the repository's `schemas/` folder:

| File | Describes |
| --- | --- |
| `lousho.workspace.v1.json` | `workspace.json` |
| `lousho.page.v1.json` | `page.json` |
| `lousho.harness.v1.json` | `harness.json` (page, base harness or profile) |
| `lousho.main-harness.v1.json` | `main-harness.json` |
| `lousho.agents.v1.json` | `agents.json` |
| `lousho.ui.v1.json` | `ui/page.ui.json` |
| `lousho.policy.v1.json` | `shared/policies/policy.json` |
| `lousho.authoring-ops.v1.json` | One authoring operation |

Each file has a stable `$id`, `https://lousho.com/schemas/<file>`, and the folder ships in the npm package (`node_modules/lousho/schemas/`). Regenerate them with `npm run workspaces:schema`; `npm run workspaces:schema:check` and a test fail when they are stale. The export follows `agentSpecV2JsonSchema()`: it comes from the zod schema, so it carries structure, enums, patterns, bounds and strictness. A page UI's recursive component is a `$ref` into `definitions`.

Rules that need code are only in the zod schemas and `validateWorkspace`. The schema negatives JSON Schema cannot express are `harness-duplicate-constraint-id` (unique ids), `attachment-duplicate-alias` (unique aliases), `attachment-ref-no-prefix` (the agent ref grammar), `page-nested-pages` (nested pages, PRD009) and `base-harness-has-extends` (the base harness has no `id`, `version` or `extends`). The same holds for safe relative paths, the active type's required block (JSON Schema does reject a missing `goal.lead`), the forbidden-key scans below free-form maps, the plain-text rules of the UI, and every cross-file check. The schema test rejects five schema negatives: `harness-permissions`, `harness-execution-key`, `attachment-tools-add`, `page-goal-without-lead` and `ui-html-prop`; the last needs the recursive reference unrolled, because the test validator turns a recursive `$ref` into "any". Use an editor's JSON Schema support for completion, and `validateWorkspace` for the answer.

## What is deferred

- **Later:** the lock and version pinning, the visual workflow canvas, the page UI editor, a shared React editor package, publishing (pack, install, deploy, spec export), remote page execution (`page.runtime` stays reserved) and several server instances.
- **P1:** `WorkspaceSource` and the loader, the resolvers for agents, harnesses and shared context, policy enforcement, prompt assembly with engine framing, the page runtime and the `single` engine, the main agent and router, `createWorkspaceRuntime`, the artifact store and the span emitter.
- **P2 and after:** the service, the typed client, drafts and revisions behind `expectedRevision`, the other three engines, the React page renderer and the improvement loop.
