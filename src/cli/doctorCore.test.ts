import { describe, it, expect } from 'vitest';
import { runDoctor } from './doctorCore';
import { renderJson, renderReport } from './doctorRender';
import type { DoctorCheck, DoctorEnvironment } from './doctorTypes';
import type { AgentSpec } from '../spec/schema';

const SECRET = 'sk-super-secret-value-123456';

const INSTALLED: Record<string, string> = {
  ai: '4.3.19',
  zod: '3.25.76',
  '@ai-sdk/openai': '0.0.42',
  '@ai-sdk/anthropic': '0.0.42',
  'ollama-ai-provider': '1.2.0',
  dockerode: '5.0.1',
  '@modelcontextprotocol/sdk': '1.30.1',
  prompts: '2.4.2',
};

function makeEnv(overrides: Partial<DoctorEnvironment> = {}): DoctorEnvironment {
  return {
    nodeVersion: '22.19.0',
    env: {},
    sdk: {
      engines: { node: '>=22.19.0' },
      peerDependencies: {
        ai: '^4.3.19',
        zod: '^3.25.76',
        '@ai-sdk/openai': '^0.0.42',
        '@ai-sdk/anthropic': '^0.0.42',
        'ollama-ai-provider': '^1.2.0',
        dockerode: '^5.0.1',
        '@modelcontextprotocol/sdk': '^1.30.1',
        prompts: '^2.4.2',
      },
    },
    resolvePackageVersion: (name) => INSTALLED[name] ?? null,
    loadSpec: () => {
      throw new Error('no spec');
    },
    resolveTool: () => ({}),
    commandExists: () => true,
    fetch: async () => ({ ok: true, status: 200 }),
    dockerReachable: async () => true,
    ...overrides,
  };
}

async function check(env: DoctorEnvironment, id: string): Promise<DoctorCheck> {
  const report = await runDoctor(env);
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check '${id}' in ${report.checks.map((c) => c.id).join(', ')}`);
  return found;
}

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return { name: 'bot', prompt: 'hi', provider: { type: 'openai', model: 'gpt-4o' }, ...overrides };
}

describe('node check', () => {
  it('ok when the version satisfies engines.node', async () => {
    expect((await check(makeEnv(), 'node')).status).toBe('ok');
  });
  it('fail with a fix when too old', async () => {
    const result = await check(makeEnv({ nodeVersion: '18.0.0' }), 'node');
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('>=22.19.0');
  });
  it('ok when the SDK declares no engines', async () => {
    expect((await check(makeEnv({ sdk: {} }), 'node')).status).toBe('ok');
  });
});

describe('required peers', () => {
  it('ok when installed within range', async () => {
    expect((await check(makeEnv(), 'peer.ai')).status).toBe('ok');
  });
  it('fail when missing, with the install command', async () => {
    const env = makeEnv({ resolvePackageVersion: (n) => (n === 'zod' ? null : INSTALLED[n] ?? null) });
    const result = await check(env, 'peer.zod');
    expect(result.status).toBe('fail');
    expect(result.fix).toBe('npm install zod@^3.25.76');
  });
  it('fail when the version is outside the peer range', async () => {
    const env = makeEnv({ resolvePackageVersion: (n) => (n === 'ai' ? '3.0.0' : INSTALLED[n] ?? null) });
    const result = await check(env, 'peer.ai');
    expect(result.status).toBe('fail');
    expect(result.finding).toContain('^4.3.19');
  });
  it('ok without a declared range', async () => {
    const result = await check(makeEnv({ sdk: { engines: { node: '>=1' } } }), 'peer.ai');
    expect(result.status).toBe('ok');
  });
});

describe('optional provider peers', () => {
  const without = (missing: string) => (n: string) => (n === missing ? null : INSTALLED[n] ?? null);

  it('ok when installed', async () => {
    expect((await check(makeEnv(), 'optional-peer.@ai-sdk/openai')).status).toBe('ok');
  });
  it('warn with an install command when missing and unused', async () => {
    const result = await check(
      makeEnv({ resolvePackageVersion: without('@ai-sdk/anthropic') }),
      'optional-peer.@ai-sdk/anthropic'
    );
    expect(result.status).toBe('warn');
    expect(result.fix).toBe('npm install @ai-sdk/anthropic@^0.0.42');
  });
  it('fail when missing and the spec needs it', async () => {
    const env = makeEnv({
      resolvePackageVersion: without('@ai-sdk/openai'),
      specPath: 'a.yaml',
      loadSpec: () => spec(),
    });
    expect((await check(env, 'optional-peer.@ai-sdk/openai')).status).toBe('fail');
  });
  it('warn on an out-of-range version, fail when needed', async () => {
    const old = (n: string) => (n === 'ollama-ai-provider' ? '0.1.0' : INSTALLED[n] ?? null);
    expect((await check(makeEnv({ resolvePackageVersion: old }), 'optional-peer.ollama-ai-provider')).status).toBe('warn');
    const needed = makeEnv({
      resolvePackageVersion: old,
      specPath: 'a.yaml',
      loadSpec: () => spec({ provider: { type: 'ollama', model: 'llama3' } }),
    });
    expect((await check(needed, 'optional-peer.ollama-ai-provider')).status).toBe('fail');
  });
});

describe('ai / provider package pairing (LOU-D28d)', () => {
  const WIDE_PEERS = {
    ai: '^4.3.19 || ^6.0.0 || ^7.0.0',
    zod: '^3.25.76',
    '@ai-sdk/openai': '^0.0.42 || ^1.0.0 || ^3.0.0 || ^4.0.0',
    '@ai-sdk/anthropic': '^0.0.42 || ^1.0.0 || ^3.0.0 || ^4.0.0',
  };
  const installed = (versions: Record<string, string | null>) => (n: string) =>
    n in versions ? versions[n] : INSTALLED[n] ?? null;
  const envWith = (versions: Record<string, string | null>, extra: Partial<DoctorEnvironment> = {}) =>
    makeEnv({ sdk: { peerDependencies: WIDE_PEERS }, resolvePackageVersion: installed(versions), ...extra });

  it('flags ai 7 with @ai-sdk/openai 1.x, with the fix for ai 7', async () => {
    const result = await check(envWith({ ai: '7.0.1', '@ai-sdk/openai': '1.3.24' }), 'optional-peer.@ai-sdk/openai');
    expect(result).toMatchObject({
      status: 'warn',
      finding: '1.3.24 installed, but ai 7 needs ^4.0.0',
      fix: 'npm install @ai-sdk/openai@^4.0.0',
    });
  });

  it('fails a mismatched pairing the agent spec needs', async () => {
    const env = envWith({ ai: '6.0.5', '@ai-sdk/openai': '4.0.1' }, { specPath: 'a.yaml', loadSpec: () => spec() });
    const result = await check(env, 'optional-peer.@ai-sdk/openai');
    expect(result).toMatchObject({ status: 'fail', fix: 'npm install @ai-sdk/openai@^3.0.0' });
  });

  it('accepts @ai-sdk/* 0.0.x and 1.x with ai 4, and 4.x with ai 7', async () => {
    expect((await check(envWith({ '@ai-sdk/openai': '1.3.24' }), 'optional-peer.@ai-sdk/openai')).status).toBe('ok');
    expect((await check(envWith({ ai: '7.0.0', '@ai-sdk/openai': '4.0.83' }), 'optional-peer.@ai-sdk/openai')).status).toBe('ok');
  });

  it('checks ollama-ai-provider-v2 on ai 7, and its fix states the zod 4 limitation', async () => {
    const report = await runDoctor(envWith({ ai: '7.0.0', 'ollama-ai-provider-v2': null }));
    expect(report.checks.find((c) => c.id === 'optional-peer.ollama-ai-provider')).toBeUndefined();
    const result = await check(envWith({ ai: '7.0.0', 'ollama-ai-provider-v2': null }), 'optional-peer.ollama-ai-provider-v2');
    expect(result.fix).toMatch(/^npm install ollama-ai-provider-v2@\^4\.0\.0 \(note: .*zod 4/);
  });

  it('a missing or unsupported ai gets one installable range, and provider hints for ai 7', async () => {
    for (const ai of [null, '5.0.0']) {
      expect((await check(envWith({ ai }), 'peer.ai')).fix).toBe('npm install ai@^7.0.0');
      expect((await check(envWith({ ai, '@ai-sdk/openai': null }), 'optional-peer.@ai-sdk/openai')).fix).toBe(
        'npm install @ai-sdk/openai@^4.0.0'
      );
    }
  });
});

describe('optional feature peers (LOU-D40)', () => {
  const without = (missing: string) => (n: string) => (n === missing ? null : INSTALLED[n] ?? null);

  it.each([
    ['dockerode', 'Docker sandboxing'],
    ['@modelcontextprotocol/sdk', 'MCP'],
    ['prompts', 'lousho init'],
  ])('%s: ok line says what it enables', async (name, enables) => {
    const result = await check(makeEnv(), `optional-peer.${name}`);
    expect(result.status).toBe('ok');
    expect(result.finding).toContain(enables);
  });

  it.each([
    ['dockerode', 'npm install dockerode@^5.0.1'],
    ['@modelcontextprotocol/sdk', 'npm install @modelcontextprotocol/sdk@^1.30.1'],
    ['prompts', 'npm install prompts@^2.4.2'],
  ])('%s: warn with the exact install command when missing', async (name, fix) => {
    const result = await check(makeEnv({ resolvePackageVersion: without(name) }), `optional-peer.${name}`);
    expect(result.status).toBe('warn');
    expect(result.fix).toBe(fix);
  });

  it('dockerode fails when missing and the spec uses a sandboxed tool', async () => {
    const env = makeEnv({
      resolvePackageVersion: without('dockerode'),
      specPath: 'a.yaml',
      loadSpec: () => spec({ tools: ['sandboxed'] }),
      resolveTool: () => ({ requiresSandbox: true }),
    });
    expect((await check(env, 'optional-peer.dockerode')).status).toBe('fail');
  });

  it('warns on an out-of-range version', async () => {
    const old = (n: string) => (n === 'prompts' ? '1.0.0' : INSTALLED[n] ?? null);
    expect((await check(makeEnv({ resolvePackageVersion: old }), 'optional-peer.prompts')).finding).toContain('expects ^2.4.2');
  });
});

describe('API keys', () => {
  it('ok and prints only "set" when the variable is set', async () => {
    const result = await check(makeEnv({ env: { OPENAI_API_KEY: SECRET } }), 'env.openai');
    expect(result).toMatchObject({ status: 'ok', finding: 'set', title: 'openai (OPENAI_API_KEY)' });
  });
  it('shows the base URL an OpenAI-compatible endpoint is read from, without credentials or query', async () => {
    const env = makeEnv({ env: { OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: 'http://user:pw@localhost:1234/v1?key=x' } });
    const result = await check(env, 'env.openai');
    expect(result.finding).toBe('set; base URL http://localhost:1234/v1 (from OPENAI_BASE_URL)');
    expect((await check(makeEnv({ env: { OPENAI_BASE_URL: 'http://localhost:1234/v1' } }), 'env.openai')).finding).toBe(
      'not set; base URL http://localhost:1234/v1 (from OPENAI_BASE_URL)'
    );
  });
  it('warn with a fix when not set', async () => {
    const result = await check(makeEnv(), 'env.anthropic');
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('ANTHROPIC_API_KEY');
  });
  it('fail when not set and the spec needs it', async () => {
    const env = makeEnv({ specPath: 'a.yaml', loadSpec: () => spec() });
    expect((await check(env, 'env.openai')).status).toBe('fail');
  });
  it('ollama needs no key: unset is ok', async () => {
    const env = makeEnv({
      specPath: 'a.yaml',
      loadSpec: () => spec({ provider: { type: 'ollama', model: 'llama3' } }),
    });
    expect((await check(env, 'env.ollama')).status).toBe('ok');
  });
  it('says which provider createAgent() would pick from the env, without the key', async () => {
    const picked = await check(makeEnv({ env: { ANTHROPIC_API_KEY: SECRET } }), 'env.default');
    expect(picked.status).toBe('ok');
    expect(picked.finding).toContain('anthropic/');
    const explicit = await check(makeEnv({ env: { LOUSHO_MODEL: 'openai/gpt-4o' } }), 'env.default');
    expect(explicit.finding).toContain('openai/gpt-4o');
  });
  it('warns when createAgent() would have nothing to pick', async () => {
    const result = await check(makeEnv(), 'env.default');
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('LOUSHO_MODEL');
  });
  it('never leaks a key value into text or JSON output', async () => {
    const env = makeEnv({
      env: { OPENAI_API_KEY: SECRET, ANTHROPIC_API_KEY: `${SECRET}-2`, OPENROUTER_API_KEY: SECRET },
    });
    const report = await runDoctor(env);
    for (const output of [renderReport(report), renderReport(report, { color: true }), renderJson(report)]) {
      expect(output).not.toContain('sk-');
      expect(output).not.toContain('secret');
    }
  });
});

describe('spec checks', () => {
  const withSpec = (loaded: AgentSpec, extra: Partial<DoctorEnvironment> = {}) =>
    makeEnv({ specPath: 'a.yaml', loadSpec: () => loaded, ...extra });

  it('reports validation errors with field paths', async () => {
    const env = makeEnv({
      specPath: 'a.yaml',
      loadSpec: () => {
        throw new Error("loadSpec: 'a.yaml' failed validation - 'provider.model': Required");
      },
    });
    const result = await check(env, 'spec');
    expect(result.status).toBe('fail');
    expect(result.finding).toContain("'provider.model'");
  });
  it('ok for a valid spec', async () => {
    expect((await check(withSpec(spec()), 'spec')).status).toBe('ok');
  });
  it('fails an unknown provider type but accepts mock', async () => {
    const unknown = await check(withSpec(spec({ provider: { type: 'foo', model: 'm' } })), 'spec.provider');
    expect(unknown.status).toBe('fail');
    const mock = await check(withSpec(spec({ provider: { type: 'mock', model: 'm' } })), 'spec.provider');
    expect(mock.status).toBe('ok');
  });
  it('checks tools against the built-in registry', async () => {
    const resolveTool = (name: string) => {
      if (name === 'nope') throw new Error("unknown tool 'nope'");
      return {};
    };
    const env = withSpec(spec({ tools: ['http', 'nope'] }), { resolveTool });
    expect((await check(env, 'spec.tool.http')).status).toBe('ok');
    const bad = await check(env, 'spec.tool.nope');
    expect(bad.status).toBe('fail');
    expect(bad.fix).toContain("Remove 'nope'");
  });
  it('checks MCP server commands from the validated spec field (LOU-D20)', async () => {
    const commandExists = (command: string) => command === 'npx';
    const env = withSpec(
      spec({
        mcpServers: {
          fs: { command: 'npx' },
          gone: { command: 'nonexistent' },
          docs: { url: 'https://example.com/mcp' },
        },
      }),
      { commandExists }
    );
    expect((await check(env, 'spec.mcp.fs')).status).toBe('ok');
    const gone = await check(env, 'spec.mcp.gone');
    expect(gone.status).toBe('fail');
    expect(gone.fix).toContain('mcpServers.gone.command');
    expect((await check(env, 'spec.mcp.docs')).status).toBe('ok');
  });
  it('reports an invalid mcpServers entry as a spec failure', async () => {
    const env = withSpec(spec(), {
      loadSpec: () => {
        throw new Error("'mcpServers.fs': AgentSpec validation failed: missing 'command'");
      },
    });
    const result = await check(env, 'spec');
    expect(result.status).toBe('fail');
    expect(result.finding).toContain('mcpServers.fs');
  });
});

describe('spec policy checks (LOU-X5)', () => {
  const withPolicy = (policy: AgentSpec['policy']) =>
    makeEnv({ specPath: 'a.yaml', loadSpec: () => spec({ policy }) });

  it('reports one line per policy block', async () => {
    const report = await runDoctor(
      withPolicy({
        requiresApproval: ['send_email'],
        guardrails: ['max-length', { name: 'deny-topics', topics: ['x'] }],
        limits: { maxSteps: 4 },
        askQuestion: true,
        compaction: true,
      })
    );
    const lines = report.checks.filter((c) => c.id.startsWith('spec.policy.')).map((c) => [c.id, c.status, c.finding]);
    expect(lines).toEqual([
      ['spec.policy.approval', 'ok', 'asks for approval before: send_email'],
      ['spec.policy.guardrails', 'ok', 'max-length, deny-topics'],
      ['spec.policy.limits', 'ok', 'maxSteps=4'],
      ['spec.policy.askQuestion', 'ok', 'the agent can ask the user questions'],
      ['spec.policy.compaction', 'ok', 'on'],
    ]);
  });

  it('reports nothing for a spec without a policy', async () => {
    const report = await runDoctor(withPolicy(undefined));
    expect(report.checks.some((c) => c.id.startsWith('spec.policy.'))).toBe(false);
  });

  it('flags unknown guardrail names with did-you-mean and the available names', async () => {
    const result = await check(withPolicy({ guardrails: ['deny-topic', 'secret-scan'] }), 'spec.policy.guardrails');
    expect(result.status).toBe('fail');
    expect(result.finding).toContain("unknown guardrail 'deny-topic' (did you mean 'deny-topics'?)");
    expect(result.finding).toContain('Available: max-length, secret-scan, regex, deny-topics, llm-judge, pii, secrets, prompt-injection, moderation');
    expect(result.fix).toContain('policy.guardrails');
  });
});

describe('ollama check', () => {
  const ollamaSpec = spec({ provider: { type: 'ollama', model: 'llama3' } });

  it('is skipped unless the spec uses ollama or OLLAMA_HOST is set', async () => {
    const report = await runDoctor(makeEnv());
    expect(report.checks.some((c) => c.id === 'ollama')).toBe(false);
  });
  it('ok when reachable (OLLAMA_HOST without a scheme is normalised)', async () => {
    const urls: string[] = [];
    const env = makeEnv({
      env: { OLLAMA_HOST: 'box:11434' },
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200 };
      },
    });
    expect((await check(env, 'ollama')).status).toBe('ok');
    expect(urls).toEqual(['http://box:11434/api/tags']);
  });
  it('warn when the server answers with an error status', async () => {
    const env = makeEnv({ env: { OLLAMA_HOST: 'http://x' }, fetch: async () => ({ ok: false, status: 503 }) });
    const result = await check(env, 'ollama');
    expect(result.status).toBe('warn');
    expect(result.finding).toContain('503');
  });
  it('warn when the request fails; uses the default endpoint for a spec', async () => {
    const urls: string[] = [];
    const env = makeEnv({
      specPath: 'a.yaml',
      loadSpec: () => ollamaSpec,
      fetch: async (url) => {
        urls.push(url);
        throw new Error('ECONNREFUSED');
      },
    });
    const result = await check(env, 'ollama');
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('ollama serve');
    expect(urls[0]).toBe('http://localhost:11434/api/tags');
  });
});

describe('docker check', () => {
  it('ok when reachable', async () => {
    expect((await check(makeEnv(), 'docker')).finding).toContain('reachable');
  });
  it('informational ok when unreachable and not needed', async () => {
    const result = await check(makeEnv({ dockerReachable: async () => false }), 'docker');
    expect(result.status).toBe('ok');
  });
  it('warn when unreachable and a sandboxed tool is configured', async () => {
    const env = makeEnv({
      dockerReachable: async () => {
        throw new Error('no socket');
      },
      specPath: 'a.yaml',
      loadSpec: () => spec({ tools: ['sandboxed'] }),
      resolveTool: () => ({ requiresSandbox: true }),
    });
    const result = await check(env, 'docker');
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('Docker');
  });
});

describe('report, rendering and exit codes', () => {
  it('exit code 0 with warnings only, 1 with any failure', async () => {
    expect((await runDoctor(makeEnv())).exitCode).toBe(0);
    expect((await runDoctor(makeEnv({ nodeVersion: '10.0.0' }))).exitCode).toBe(1);
  });

  it('renders a mixed report as plain ASCII text', async () => {
    const env = makeEnv({
      env: { OPENAI_API_KEY: SECRET },
      resolvePackageVersion: (n) => (n === 'ollama-ai-provider' ? null : INSTALLED[n] ?? null),
      dockerReachable: async () => false,
      nodeVersion: '20.1.0',
    });
    const text = renderReport(await runDoctor(env));
    expect(text).toMatchInlineSnapshot(`
      "lousho doctor

      [FAIL] Node.js: v20.1.0 does not satisfy >=22.19.0
             fix: Install a Node.js version matching ">=22.19.0" (for example with nvm: nvm install --lts).
      [ ok ] Required peer ai: 4.3.19 satisfies ^4.3.19
      [ ok ] Required peer zod: 3.25.76 satisfies ^3.25.76
      [ ok ] Provider package @ai-sdk/openai: 0.0.42 installed
      [ ok ] Provider package @ai-sdk/anthropic: 0.0.42 installed
      [warn] Provider package ollama-ai-provider: not installed (optional)
             fix: npm install ollama-ai-provider@^1.2.0
      [warn] Provider package @earendil-works/pi-ai: not installed (optional)
             fix: npm install @earendil-works/pi-ai@1.0.3
      [ ok ] Optional package dockerode: 5.0.1 installed - enables Docker sandboxing (SubprocessSandbox)
      [ ok ] Optional package @modelcontextprotocol/sdk: 1.30.1 installed - enables MCP (serveMcp, \`lousho mcp\` and MCP client connections)
      [ ok ] Optional package prompts: 2.4.2 installed - enables the interactive prompts of \`lousho init\` (pass --yes to skip them)
      [warn] Optional package quickjs-emscripten: not installed (optional) - enables code mode (\`createAgent({ codeMode })\`)
             fix: npm install quickjs-emscripten@^0.32.0
      [ ok ] openai (OPENAI_API_KEY): set
      [warn] anthropic (ANTHROPIC_API_KEY): not set
             fix: Set ANTHROPIC_API_KEY in your environment, e.g. export ANTHROPIC_API_KEY=<your key>
      [warn] openrouter (OPENROUTER_API_KEY): not set
             fix: Set OPENROUTER_API_KEY in your environment, e.g. export OPENROUTER_API_KEY=<your key>
      [ ok ] ollama (OLLAMA_BASE_URL): not set (optional; the provider default endpoint is used)
      [ ok ] pi (OPENROUTER_API_KEY): not set (only needed by the matching nested provider; each pi provider reads its own env key)
      [ ok ] Default provider for createAgent(): would use 'openai/gpt-4o-mini'
      [ ok ] Docker: daemon not reachable (only needed for sandboxed tools; none configured)

      12 ok, 5 warnings, 1 failure"
    `);
    expect(text).not.toMatch(/[^\x20-\x7e\n]/);
  });

  it('colours only the status tag when asked', async () => {
    const text = renderReport(await runDoctor(makeEnv()), { color: true });
    expect(text).toContain('\u001b[32m[ ok ]\u001b[0m');
  });

  it('renders JSON that round-trips', async () => {
    const report = await runDoctor(makeEnv());
    expect(JSON.parse(renderJson(report))).toEqual(report);
  });
});
