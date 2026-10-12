# Eve — DX, CLI, packaging & onboarding findings

Repo: `E:\agent-sdk` (`main`, `1.0.0-alpha.19`). Method: read README/docs, ran the built CLI (`node bin/lousho.js …`) for init/doctor/dev/chat/acp/add/mcp/eval/traces/build/studio, packed a dry-run tarball (`npm pack --dry-run`), queried the live npm registry (`npm view`), and compared `src/index.ts` exports against examples and docs.

## Summary

The SDK's CLI fundamentals are strong: strict `parseArgs`-based flag parsing with `LOUSHO_CONFIG_INVALID` usage errors and `-h` everywhere; `lousho doctor` prints per-check fixes; `lousho add` shows a real permission manifest, file list, dependency note, and writes a signed receipt; `lousho init` produces a genuinely runnable ESM project with an offline `mockModel` test; nearly every error carries a `LOUSHO_*` code plus a docs URL. The registry fallback, `--yes`/`--allow` early check, doctor base-URL check, agent-dir error codes and override forwarding (the listed prior fixes) are all present and verified — not re-reported.

The bad news for a first-30-minute evaluator is concentrated at the very top of the funnel: **`npm install @lousho/build-ai-agent` installs `1.0.0-alpha.0` — eighteen releases stale** — because `latest` was poisoned by an out-of-order publish. After that, the seams are smaller but real: `lousho mcp` crashes raw on a directory, `lousho add` happily writes dead files into a non-agent-dir project, examples dogfood `../../src` instead of the package and three headline examples still teach the legacy `AgentBuilder`/`AgentExecutor` API, and every install carries ~5 MB of studio app, docs and TS source. Branding splits across `@lousho/build-ai-agent` / `lousho` / `create-lousho-agent` / "Agent Forge" (`lousho studio`) with an orphaned `create-loushy-agent` workspace to boot.

### What already works well (don't "fix")

- `lousho doctor`: `[ ok ]/[warn]/[fail]` checklist, every warning carries a `fix:` line, exit code reflects failures.
- `lousho add`: permission manifest review, `--dry-run`, `--allow` gating, SHA-256 receipt (`lousho-registry.json`), refusal messages cite the exact flags needed.
- Error style: `SDKError` + `LOUSHO_*` code + actionable hint + `errors.md` anchor link, used consistently (except findings F2/F7).
- `lousho init`: clean ESM/NodeNext scaffold, real package imports, offline vitest test, per-provider `--provider`, `--template`, `--package-manager`, `--sdk-path`; refuses non-empty dirs with a good message.
- `agent.json` validation: strict known-keys check with closest-match suggestions (`validateConfig.ts:185-193`).
- `lousho dev` import failures are explained in plain language ("Node resolves 'zod' from node_modules … npm install zod").
- `prompts`, `tsup`, peers all lazy-loaded with coded "install this" errors.

---

## Findings

### F1 — `npm install @lousho/build-ai-agent` installs a 18-releases-stale `alpha.0` (latest dist-tag poisoned)

- **Severity:** critical
- **Persona:** AI engineer / PM (the single most damaging first-30-minutes bug)
- **Evidence:** `npm view @lousho/build-ai-agent dist-tags` → `{ latest: '1.0.0-alpha.0', alpha: '1.0.0-alpha.19' }`. `npm view … time` shows `alpha.0` published **after** `alpha.9` (2026-10-04T18:30Z), i.e. someone ran plain `npm publish` without `--tag alpha` on an old build, and `latest` has pointed at it ever since. The README (`README.md:53`) and `docs/installation.md` both tell new users to run `npm install @lousho/build-ai-agent ai@^7.0.0 zod` — that resolves `latest` → **alpha.0**, an API generation that predates the `createAgent()`-centric docs (there is even a `migrating-to-create-agent.md` doc for APIs newer than that build). Snippets like `createAgent({ model })`, `agent.approvals.resolve`, `@lousho/build-ai-agent/testing` may not exist or behave differently there.
- **Why it matters:** the documented happy path installs a different product than the docs describe. Every other finding in this file is downstream noise compared to this.
- **Fix:** `npm dist-tag add @lousho/build-ai-agent@1.0.0-alpha.19 latest` (or repoint docs to `@lousho/build-ai-agent@alpha`), and add a release step/CI check asserting `latest` is the newest published version. Same disease, milder: `create-lousho-agent@latest` = `0.1.1` vs `alpha` = `0.1.2-alpha.4` (F12).

### F2 — `lousho mcp <agent-directory>` crashes with a raw `EISDIR`, no code, no hint

- **Severity:** high
- **Persona:** Software engineer
- **Evidence:** `lousho mcp ./adir` → `EISDIR: illegal operation on a directory, read` (repro). `src/cli/mcp.ts:41` calls `loadSpec(path.resolve(configPath))` with no directory pre-check; `runMcp`'s catch (`mcp.ts:62-64`) prints the bare `error.message` — no `lousho mcp:` prefix, no `LOUSHO_*` code, no docs link. `dev`, `chat` and `acp` all accept agent directories; `mcp` is the odd one out (usage says `<agent.yaml|json>`), so a user who just learned "the CLI takes agent dirs" gets an uncaught fs error for guessing the obvious.
- **Why it matters:** the one command with narrower input also has the worst error. Looks unpolished exactly where a MCP-curious evaluator lands.
- **Fix:** detect `fs.statSync(p).isDirectory()` (reuse `detectTarget` or a `SPEC_EXT` check) and throw `LOUSHO_CONFIG_INVALID` ("agent spec file required; agent directories aren't supported by `lousho mcp`") — or better, accept agent dirs like the sibling commands do.

### F3 — `lousho add` writes into any directory — in an `init` project it drops a dead tool file nothing loads

- **Severity:** high
- **Persona:** AI engineer
- **Evidence:** `src/cli/add.ts:175-181` validates only that `--dir` exists and is a directory. Repro: `lousho init my-agent` (scaffolds `src/agent.ts`, no `agent.json`), then `lousho add open-meteo-weather --yes --allow network` from inside it → succeeds, writes `tools/open-meteo-weather.ts` + `lousho-registry.json` at project root. The scaffolded agent (`src/agent.ts`: `const tools = [currentTime]`) never reads `tools/`, so the install is a no-op the user cannot detect — `npm run dev` still has one tool.
- **Why it matters:** the two headline onboarding flows (`init` then `add`) are structurally incompatible and nothing says so. A new user concludes "`add` is broken" or "the agent ignores tools".
- **Fix:** when `--dir` contains no `agent.json`/`agent.yaml`/`agent.ts`, either refuse with a hint ("this isn't an agent directory — `lousho init` projects import tools in `src/agent.ts`; import it there, or create an agent dir") or at minimum warn post-write that nothing loads the file automatically. Longer term: let `init` scaffold an agent directory so the flows compose.

### F4 — Published package is 5.1 MB packed / 19.2 MB unpacked; ships a full web app, 1 MB of llms text, and all of `src/`

- **Severity:** medium
- **Persona:** Software engineer (install size, audit surface)
- **Evidence:** `npm pack --dry-run`: package size 5.1 MB, unpacked 19.2 MB, 984 files. Biggest contributors: `apps/agent-forge/dist-server/index.cjs` 1.4 MB + client bundle ~1.2 MB, `llms-full.txt` 978 kB, `src/` 405 files (kept deliberately for sourcemap `sources`, `tsup.config.ts:82-85`), `dist/` 503 files incl. maps. `files` (`package.json:117-140`) also ships all `docs/*.md` and `CHANGELOG.md` (268 kB).
- **Why it matters:** every `npm install` — including CI and Docker images — downloads a bundled React dashboard, a megabyte of docs-as-text, and the full TS source. Competitors' agent SDKs install a fraction of this. It also makes `create-lousho-agent` (which hard-depends on the SDK, `packages/create-lousho-agent/package.json`) a 19 MB scaffold.
- **Fix:** consider a separate `@lousho/agent-forge` / `lousho-studio` package (or download-on-first-`studio`), and move `llms-full.txt` to docs-site/lazy-fetch (keep `llms.txt` small index). If `src/` stays for sourcemaps, say so in `docs/installation.md` so the size is a stated trade-off, not a surprise.

### F5 — Examples import `../../src` instead of `@lousho/build-ai-agent`; the audit's own rules forbid it

- **Severity:** medium
- **Persona:** AI engineer
- **Evidence:** 48 files under `examples/` import `from '../../src'` / `../../src/testing` (e.g. `examples/support-bot/index.ts`, `examples/data-analyst/index.ts`); only the kit tests use `@lousho/build-ai-agent/testing` and a few examples have `package.json` stubs. `audit/AUDIT_BRIEF.md:28` explicitly instructs consumer harnesses: "Import only from `@lousho/build-ai-agent` (and its subpaths) — never from `../../src`."
- **Why it matters:** copying an example into a real project fails at the first import line; examples also can't validate the *published* surface (exactly the class of drift this audit hunts). Users learn a path style that only exists inside this repo.
- **Fix:** point example `package.json`s at `file:../..` (or the published spec) and rewrite imports to `@lousho/build-ai-agent` and `@lousho/build-ai-agent/testing`; keep a CI job type-checking them against the packed tarball.

### F6 — README's "flagship" example and two others teach the legacy `AgentBuilder`/`AgentExecutor` API

- **Severity:** medium
- **Persona:** AI engineer / PM
- **Evidence:** 9 files in 3 examples use `AgentBuilder`, `AgentExecutor`, `ToolRegistry`: `examples/ops-pipeline/{index,monitor,fixer,slackInteractions,pipeline.eval}.ts` (README:276 calls ops-pipeline "Flagship"), `examples/tracing/{run-console,run-otel,weather-scenario}.ts`, `examples/openrouter/index.ts`. `weather-scenario.ts:8` even does `import { tool } from 'ai'` — the Vercel helper, not `defineTool`. Meanwhile README and `docs/migrating-to-create-agent.md` position `createAgent()` as *the* API and executor pieces as "lower-level".
- **Why it matters:** an evaluator following README → "flagship" example meets an API the docs tell them to migrate *away* from. It reads as two products.
- **Fix:** port ops-pipeline and tracing to `createAgent` (or clearly retitle them "advanced/executor API examples"), and replace `tool` from `ai` with `defineTool`.

### F7 — `lousho build` leaks raw esbuild errors where `lousho dev` gives a coded, actionable one

- **Severity:** medium
- **Persona:** Software engineer / Designer (error quality)
- **Evidence:** same agent dir, missing `zod`: `lousho dev` → `LOUSHO_AGENT_DIR_INVALID` with "npm install zod" guidance; `lousho build ./adir --target=node-server` → raw `X [ERROR] Could not resolve "zod"` + `ESM Build failed` + esbuild's own hint ("mark the path as external" — wrong advice here), and it leaves a half-written `out/` (scaffold files present, `dist/` missing). `src/deploy/adapters/node-server.ts:291-317` calls `loadTsup().build` with no error translation (`LOUSHO_BUILD_VERBOSE` only controls noise).
- **Why it matters:** inconsistent error quality across commands; esbuild's suggestion actively misleads.
- **Fix:** catch bundling failures and map unresolved-module errors to the same "install X in the agent dir's project" guidance `loadAgentDir` produces; consider cleaning `out/` on failure or warning that it's partial.

### F8 — `lousho chat` / `lousho acp` report path errors as "`lousho dev:`"

- **Severity:** medium
- **Persona:** Designer (error correctness)
- **Evidence:** `lousho chat ./missing-dir` prints `lousho dev: './missing-dir' does not exist.` `src/cli/devReload.ts:81` hard-codes `lousho dev:` inside `detectTarget`, which `chat.ts:62` and `acp.ts` share. Same hard-coding at `devReload.ts:85` for unsupported extensions.
- **Fix:** pass the calling command's name into `detectTarget`/`loadTarget` (or use a neutral prefix).

### F9 — No `lousho --version` / `-v`; `lousho --version` exits 1 as "unknown command"

- **Severity:** medium
- **Persona:** Software engineer (first thing run in any eval: `x --version`)
- **Evidence:** `bin/lousho.js` `COMMANDS` maps only `--help`/`-h`/`help`; `--version` → `lousho: unknown command '--version'.` A `VERSION` constant exists (`src/index.ts:9`, `1.0.0-alpha.19`) and `scripts/sync-version.mjs` keeps it in sync, but the CLI never prints it.
- **Fix:** add `['--version' | '-v' | 'version']` → print `VERSION`; doctor's Node check line already proves the plumbing.

### F10 — Top-level `lousho --help` usage is stale vs the commands' own usage

- **Severity:** medium
- **Persona:** Designer / SWE (two sources of truth)
- **Evidence:** `bin/lousho.js` `USAGE` omits `doctor --ping` (exists: `src/cli/doctor.ts:30-36`, documented `docs/cli.md:14`) and `eval --timeout` (exists in `eval`'s usage error). `init`'s own `--help` is a different, richer format; `docs/cli.md` maintains a third copy of the same block.
- **Fix:** generate the banner from each command's `CommandSpec.usage` (they already exist) so help can't drift; spot-checked commands otherwise match.

### F11 — Naming soup: `lousho` vs `@lousho/build-ai-agent` vs "Agent Forge" vs `lousho studio`; plus an orphaned `create-loushy-agent` workspace

- **Severity:** medium
- **Persona:** Designer / PM
- **Evidence:** package `@lousho/build-ai-agent` (a verb phrase as the product name — compare `ai`, `mastra`, `voltagent`); binary `lousho`; scaffolder `create-lousho-agent`; the visual tool is "Agent Forge" in docs, `lousho studio` on the CLI, `apps/agent-forge` on disk, `@lousho/agent-forge` as a package name — three names for one feature. `packages/create-loushy-agent/` is a typo'd orphan workspace (only `dist/`, `node_modules/`, **no `package.json`**) still matched by the `packages/*` workspace glob.
- **Why it matters:** unpronounceable brand + verb-phrase package + three names for the studio = every doc and conference mention is confusing. Honestly: 'lousho' is a weak name (hard to say, spell, or recall; auto-corrects to "lousy"/"Lou, sho?"); flagging per the brief, but at minimum unify `studio`/Agent Forge.
- **Fix:** pick one public name for the dashboard (either `lousho forge`/`lousho studio` or "Agent Forge", used everywhere); delete or restore `packages/create-loushy-agent`; consider a short import alias (`lousho`) before 1.0 freezes the name.

### F12 — `create-lousho-agent@latest` (0.1.1) lags `alpha` (0.1.2-alpha.4) and drags the whole SDK in to scaffold

- **Severity:** low
- **Persona:** SWE / AI engineer
- **Evidence:** `npm view create-lousho-agent dist-tags` → `latest: 0.1.1`; its dep `@lousho/build-ai-agent@^1.0.0-alpha.8` resolves the newest alpha at install (so the *generated* project is fine), but the scaffolder itself is stale and installs ~19 MB + peers to print a wizard.
- **Fix:** same dist-tag hygiene as F1; consider `--tag alpha` on `npm create` docs until 1.0.

### F13 — `engines: node >=22.19.0` is a patch-level floor that excludes Node 20 and almost all of 22.x

- **Severity:** low
- **Persona:** Software engineer (install friction)
- **Evidence:** `package.json:224-226`; `docs/installation.md` justifies it via `undici@8` (and native type-stripping for `lousho dev agent.ts` on ≥22.18 helps explain the floor). Any evaluator on Node 20 LTS or 22.0–22.18 gets an `EBENGINE` warning on every install.
- **Fix:** fine to keep, but surface it earlier — the README does say "Requires Node.js 22.19"; consider a sentence on *why* (native `.ts` import for `lousho dev/chat/acp`) since it reads arbitrary.

### F14 — Three vocabularies for the same fields: spec `prompt`/`provider.{type,model}` vs agent dir `instructions`/`model` vs `createAgent` `instructions`(+`prompt`)

- **Severity:** low
- **Persona:** Designer (API consistency)
- **Evidence:** `spec.yaml` `{name, prompt, provider:{type,model}}` (`src/spec/schema.ts:315-316`, `150-151`); `agent.json` `{model}` + `instructions.md`; `createAgent({ model, instructions })` where `prompt` is only an alias (`docs/quick-start.md` §1). Guessing `model:` + `instructions:` in a spec fails validation (good error, but a needless trip-wire: "missing required field 'prompt'; 'provider': Required").
- **Fix:** accept the `createAgent` spellings in the spec schema as aliases, or add a table in `docs/configuration.md` mapping the three vocabularies.

### F15 — `cp .env.example .env` is Linux/macOS-only advice in the README, generated README and quick-start

- **Severity:** low
- **Persona:** Designer (polish)
- **Evidence:** `README.md:45`, `docs/quick-start.md` §"Start a new project", and the generated project `README` (`src/cli/init` templates) all say `cp .env.example .env` — fails in Windows `cmd`/PowerShell (`copy`/`Copy-Item`). Ironically this repo is developed on Windows.
- **Fix:** "copy `.env.example` to `.env`" (words, not a command), or show both.

### F16 — `docs/` is 70 flat files with no index; test files live inside it

- **Severity:** low
- **Persona:** PM / Designer (docs IA)
- **Evidence:** no `docs/README.md`/`index.md`; the only maps are the root README table and `llms.txt`. `docs/buildACodingAgent.test.ts` and `docs/docs-links.test.ts` are test files inside the docs folder (harmless to the tarball — `files` only ships `docs/*.md` — but confusing to browsers).
- **Fix:** add `docs/README.md` mirroring the README's doc table grouped by topic (start / build / run / deploy / reference); move tests to `scripts/` or a `docs/__tests__` convention.

### F17 — Exact-pinned optional peers: `@earendil-works/pi-ai@1.0.3`, `@earendil-works/pi-coding-agent@1.0.2`

- **Severity:** low
- **Persona:** Software engineer
- **Evidence:** `package.json:230-231` — peer deps normally express ranges; exact pins mean any consumer with a different pi build gets peer-mismatch noise, and every SDK release forces a pi release in lockstep. (Compare the generous ranges on every other peer.)
- **Fix:** widen to `^1.0.x` unless a hard pin is genuinely required; if required, note it in `docs/providers.md`.

### F18 — README's registry quickstart `lousho add coding-pi --dir ./my-agent` fails if `./my-agent` doesn't exist

- **Severity:** low
- **Persona:** AI engineer
- **Evidence:** `README.md:183` shows `lousho add coding-pi --dir ./my-agent --yes --allow exec,fs-write,network,env` as a standalone snippet; `add.ts:176-178` errors `the agent directory … does not exist. Create it, or pass --dir`. For a *kit* (which creates a whole agent dir) requiring the parent to pre-exist is a papercut — `mkdir my-agent` is missing from the docs flow.
- **Fix:** either create the dir for kit installs (`--dir` absent target → offer to create), or add `mkdir my-agent` / a one-liner to the README and `docs/registry.md`.

### F19 — `lousho init --yes` scaffolds an OpenAI project even with no API key; first `npm run dev` then dead-ends

- **Severity:** low
- **Persona:** AI engineer
- **Evidence:** `lousho init my-agent --yes` in a keyless env → "Creating minimal openai agent…". `--provider` defaults "detected from your API key env var, else openai" (`init --help`). The offline `npm test` works, but the advertised `npm run dev` immediately hits `LOUSHO_PROVIDER_MISSING_API_KEY`. A zero-key evaluator never sees the agent run.
- **Fix:** when no provider env var is detected, print a one-line post-scaffold note ("no API key detected — set OPENAI_API_KEY in .env, or `npm test` runs offline"), or offer a `--template offline`/`--provider mock` path so the first run works keyless.

### F20 — No demo, no "why not X" section; hosted story is only a negative ("No hosted runtime")

- **Severity:** low
- **Persona:** PM
- **Evidence:** README is thorough but text-only — no GIF/asciinema of `init → dev → chat` (the single most convincing 30-second proof); "Four things set it apart" names strengths but never names alternatives (Mastra, Vercel `ai` `Agent`/ToolLoopAgent, LangGraph.js, OpenAI Agents SDK), which is what an evaluator is actually comparing; "No hosted runtime" is honest positioning but there's no migration/hosted path story at all.
- **Fix:** a 20-second `init`-to-reply GIF at the top of the README; a small "Lousho vs …" table (in-process runtime, replay cassettes, agent directories/kits); a roadmap note on whether managed/hosted is coming.

---

## Repro index

| # | Command / check |
|---|-----------------|
| F1 | `npm view @lousho/build-ai-agent dist-tags` |
| F2 | `lousho mcp <any-dir>` → `EISDIR` |
| F3 | `lousho init x --yes --no-install && cd x && lousho add open-meteo-weather --yes --allow network` → writes `tools/` the scaffold never loads |
| F4 | `npm pack --dry-run` → 5.1 MB / 19.2 MB / 984 files |
| F5 | `grep -rl "from '../../src" examples \| wc -l` → 48 |
| F6 | `grep -rl "AgentBuilder\|AgentExecutor" examples` → 9 files / 3 examples |
| F7 | `lousho build <agent-dir-with-unresolved-import> --target=node-server` vs `lousho dev` same dir |
| F8 | `lousho chat ./missing-dir` → "`lousho dev:` …" |
| F9 | `lousho --version` → unknown command |
| F10 | `lousho --help` vs `src/cli/doctor.ts:30` / eval usage error |
| F18 | `lousho add coding-pi --dir ./nonexistent` |
