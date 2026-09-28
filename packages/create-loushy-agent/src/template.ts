import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AnswerConfig } from './prompts';

/**
 * Locates the @loushy/build-ai-agent SDK's own package.json.
 *
 * This CLI is developed inside the same monorepo/worktree as the SDK
 * (packages/create-loushy-agent, with the SDK at the worktree root) and
 * the SDK is NOT published to the public npm registry, so a plain semver
 * dependency spec in a generated project's package.json would not be
 * installable. generateProject() instead packs the SDK's own source tree
 * with `npm pack` and copies the resulting tarball into the generated
 * project, wiring a `file:./<tarball>` dependency that installs correctly
 * from any directory, including one far outside this worktree. The
 * tarball's version always matches the SDK's real package.json version
 * exactly, which is what LOU-H4's "pinned version" requirement is about.
 */
function findSdkRoot(): string {
  // packages/create-loushy-agent/src -> packages/create-loushy-agent -> packages -> <worktree root>
  const candidate = path.resolve(__dirname, '..', '..', '..');
  const pkgPath = path.join(candidate, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `generateProject: could not locate the @loushy/build-ai-agent SDK root from ${__dirname} (expected package.json at ${pkgPath})`
    );
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== '@loushy/build-ai-agent') {
    throw new Error(
      `generateProject: expected @loushy/build-ai-agent at ${pkgPath}, found '${pkg.name}'`
    );
  }
  return candidate;
}

/** Reads the SDK's own pinned version straight from its package.json. */
export function getPinnedSdkVersion(): string {
  const sdkRoot = findSdkRoot();
  const pkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
  return pkg.version as string;
}

/** Env var each provider's generated agent reads its credential from (LOU-H5, matching LOU-F8's resolveProvider table). */
export const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
};

function toolImportLine(tool: string): string {
  if (tool === 'http') return "import { httpTool } from '@loushy/build-ai-agent/tools';";
  // 'github' (and any other future starter tool) needs real credentials
  // (token/owner/repo) that generateProject() has no value for, so it is
  // left commented out with a TODO rather than wired to a broken config.
  return `// TODO: wire up the '${tool}' tool (needs credentials) - see @loushy/build-ai-agent/tools`;
}

function toolsObjectSource(tools: string[]): string {
  const entries: string[] = [];
  if (tools.includes('http')) {
    entries.push('  http: httpTool,');
  }
  return entries.join('\n');
}

/**
 * Generates a new @loushy/build-ai-agent project at `dir`: package.json
 * (with a real, installable, exact-version-pinned SDK dependency),
 * tsconfig.json (mirroring the root project's baseline), src/agent.ts
 * (calling createAgent() with the chosen provider/tools), and a
 * .env.example naming the right provider env var (LOU-H5).
 */
export async function generateProject(dir: string, answers: AnswerConfig): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

  const sdkRoot = findSdkRoot();
  const version = getPinnedSdkVersion();

  // Pack the SDK's current source tree and copy the tarball alongside the
  // generated project so `npm install` works standalone, from any cwd.
  // shell:true is required for execFileSync to run the `npm`/`npm.cmd`
  // batch script on Windows; every argument here is either a fixed literal
  // or a path generateProject() itself computed (never raw user input),
  // so this isn't a shell-injection risk in practice.
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packOutput = execFileSync(npmCmd, ['pack', '--pack-destination', dir], {
    cwd: sdkRoot,
    encoding: 'utf8',
    shell: true,
  });
  const tarballName = packOutput.trim().split(/\r?\n/).pop()!.trim();

  const pkgJson = {
    name: answers.name,
    version: '0.1.0',
    private: true,
    type: 'commonjs',
    scripts: {
      build: 'tsc',
      start: 'node dist/agent.js',
    },
    dependencies: {
      '@loushy/build-ai-agent': `file:./${tarballName}`,
    },
    devDependencies: {
      typescript: '^5.0.0',
      '@types/node': '^20.0.0',
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');

  const tsconfig = {
    compilerOptions: {
      outDir: './dist',
      rootDir: './src',
      module: 'CommonJS',
      moduleResolution: 'node',
      target: 'ES2022',
      lib: ['ES2022'],
      skipLibCheck: true,
      strict: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      declaration: false,
      types: ['node'],
    },
    include: ['src/**/*'],
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

  const envVar = PROVIDER_ENV_VARS[answers.provider];
  fs.writeFileSync(
    path.join(dir, '.env.example'),
    `# LLM provider credential for '${answers.provider}'\n${envVar}=\n`
  );

  const toolImports = answers.tools.map(toolImportLine).join('\n');
  const toolsSource = toolsObjectSource(answers.tools);

  const agentSource = `import { createAgent } from '@loushy/build-ai-agent';
import { resolveProvider } from '@loushy/build-ai-agent';
${toolImports}

const provider = resolveProvider('${answers.provider}/${defaultModelFor(answers.provider)}');

const agent = createAgent({
  prompt: 'You are a helpful assistant built with @loushy/build-ai-agent.',
  provider,
${toolsSource ? `  tools: {\n${toolsSource}\n  },\n` : ''}});

async function main() {
  const result = await agent.send(process.argv.slice(2).join(' ') || 'hello');
  console.log(result.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
  fs.writeFileSync(path.join(dir, 'src', 'agent.ts'), agentSource);
}

function defaultModelFor(provider: string): string {
  if (provider === 'openai') return 'gpt-4o-mini';
  if (provider === 'anthropic') return 'claude-3-5-sonnet-latest';
  return 'llama3';
}
