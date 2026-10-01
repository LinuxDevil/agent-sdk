import { describe, expect, it } from 'vitest';
import { PROVIDER_NAMES, TEMPLATES, type Template } from './options';
import { renderProject, type ProjectConfig } from './templates';

const SDK = { version: '1.0.0-alpha.8', peerDependencies: { ai: '^4.3.19', zod: '^3.25.76' } };

function config(provider: string, template: Template): ProjectConfig {
  return {
    name: 'demo-agent',
    provider,
    template,
    packageManager: 'npm',
    sdkDependency: '^1.0.0-alpha.8',
    sdk: SDK,
  };
}

const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
};

/** The `ai` / provider-package pairing each provider is scaffolded with (LOU-D28d). */
const SCAFFOLD_PAIRINGS: Record<string, Record<string, string>> = {
  openai: { ai: '^7.0.0', '@ai-sdk/openai': '^4.0.0' },
  anthropic: { ai: '^7.0.0', '@ai-sdk/anthropic': '^4.0.0' },
  openrouter: { ai: '^4.3.19', '@ai-sdk/openai': '^0.0.42' },
  ollama: { ai: '^4.3.19', 'ollama-ai-provider': '^1.2.0' },
};

const combos = PROVIDER_NAMES.flatMap((provider) => TEMPLATES.map((template) => [provider, template] as const));

describe('renderProject', () => {
  it.each(combos)('%s / %s: file set and key contents', (provider, template) => {
    const files = renderProject(config(provider, template));

    const expected = ['.env.example', '.gitignore', 'README.md', 'package.json', 'src/agent.test.ts', 'tsconfig.json'];
    expected.push(...(template === 'yaml' ? ['agent.yaml'] : ['src/agent.ts', 'src/index.ts']));
    expect(Object.keys(files).sort()).toEqual(expected.sort());

    expect(files['.env.example']).toMatch(new RegExp(`^${ENV_KEYS[provider]}=$`, 'm'));
    expect(files['.gitignore']).toMatch(/^\.env$/m);
    expect(files['.gitignore']).toMatch(/^!\.env\.example$/m);

    const pkg = JSON.parse(files['package.json']!);
    expect(pkg).toMatchObject({ name: 'demo-agent', type: 'module', private: true });
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['dev', 'test', 'doctor']));
    expect(pkg.scripts.doctor).toMatch(/^loushy doctor/);
    expect(pkg.dependencies['@loushy/build-ai-agent']).toBe('^1.0.0-alpha.8');
    expect(pkg.dependencies).toMatchObject({ ai: SCAFFOLD_PAIRINGS[provider]!.ai, zod: '^3.25.76' });

    expect(JSON.parse(files['tsconfig.json']!).compilerOptions).toMatchObject({ strict: true, module: 'NodeNext' });
    expect(files['README.md']).toContain(ENV_KEYS[provider]);
    expect(files['README.md']).toContain('npm run dev');
  });

  it.each(PROVIDER_NAMES)('%s: zod pairs with the scaffolded ai major (LOU-D29)', (provider) => {
    const sdk = { ...SDK, peerDependencies: { ...SDK.peerDependencies, zod: '^3.25.76 || ^4.0.0' } };
    const pkg = JSON.parse(renderProject({ ...config(provider, 'minimal'), sdk })['package.json']!);
    const zod3Only = SCAFFOLD_PAIRINGS[provider]!.ai === '^4.3.19';
    expect(pkg.dependencies.zod).toBe(zod3Only ? '^3.25.76' : '^3.25.76 || ^4.0.0');
  });

  it.each(combos.filter(([, template]) => template !== 'yaml'))(
    '%s / %s: agent.ts uses createAgent + defineTool and the test uses mockModel',
    (provider, template) => {
      const files = renderProject(config(provider, template));
      expect(files['src/agent.ts']).toContain("import { createAgent, defineTool, type LLMProvider } from '@loushy/build-ai-agent';");
      expect(files['src/agent.ts']).toMatch(new RegExp(`model: '${provider}/[^']+'`));
      expect(files['src/agent.ts']).toContain('instructions');
      expect(files['src/agent.test.ts']).toContain("import { mockModel } from '@loushy/build-ai-agent/testing';");
      expect(files['agent.yaml']).toBeUndefined();
      expect(JSON.parse(files['package.json']!).scripts.dev).toContain('src/index.ts');
    }
  );

  it('the tools template defines more tools than minimal', () => {
    const count = (template: Template) =>
      (renderProject(config('openai', template))['src/agent.ts']!.match(/defineTool\(\{/g) ?? []).length;
    expect(count('minimal')).toBe(1);
    expect(count('tools')).toBe(3);
  });

  it.each([
    ['openai', '@ai-sdk/openai', ['@ai-sdk/anthropic', 'ollama-ai-provider']],
    ['openrouter', '@ai-sdk/openai', ['@ai-sdk/anthropic', 'ollama-ai-provider']],
    ['anthropic', '@ai-sdk/anthropic', ['@ai-sdk/openai', 'ollama-ai-provider']],
    ['ollama', 'ollama-ai-provider', ['@ai-sdk/openai', '@ai-sdk/anthropic', 'ollama-ai-provider-v2']],
  ])('%s depends on its own provider package only', (provider, peer, others) => {
    const dependencies = JSON.parse(renderProject(config(provider, 'minimal'))['package.json']!).dependencies;
    expect(Object.keys(dependencies)).toContain(peer);
    for (const other of others) expect(Object.keys(dependencies)).not.toContain(other);
  });

  it.each(Object.entries(SCAFFOLD_PAIRINGS))('%s gets one consistent ai / provider package pairing', (provider, pairing) => {
    const dependencies = JSON.parse(renderProject(config(provider, 'minimal'))['package.json']!).dependencies;
    expect(dependencies).toMatchObject(pairing);
  });

  it('the yaml template ships agent.yaml and runs it with loushy dev', () => {
    const files = renderProject(config('anthropic', 'yaml'));
    expect(files['agent.yaml']).toContain('type: anthropic');
    expect(JSON.parse(files['package.json']!).scripts.dev).toBe('loushy dev agent.yaml');
    expect(files['src/agent.ts']).toBeUndefined();
  });

  it('uses the chosen package manager in the README commands', () => {
    const files = renderProject({ ...config('openai', 'minimal'), packageManager: 'pnpm' });
    expect(files['README.md']).toContain('pnpm run dev');
    expect(files['README.md']).not.toMatch(/(^|\s)npm run/);
  });

  it.each(TEMPLATES)('snapshot: %s package.json', (template) => {
    expect(renderProject(config('openai', template))['package.json']).toMatchSnapshot();
  });

  it.each(combos.filter(([, template]) => template !== 'yaml'))('snapshot: %s / %s agent.ts', (provider, template) => {
    expect(renderProject(config(provider, template))['src/agent.ts']).toMatchSnapshot();
  });
});
