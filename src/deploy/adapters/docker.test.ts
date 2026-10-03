/**
 * LOU-I4: docker adapter.
 *
 * Always runs: Dockerfile content checks, and spy assertions proving
 * scaffold()/build() delegate to NodeServerAdapter rather than duplicating
 * its logic.
 *
 * The real `docker build` + `docker run` integration test needs a running
 * Docker daemon; it lives in docker.docker.test.ts and runs in the Linux
 * Docker CI job (`npm run test:docker`, LOU-M6).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerAdapter, DOCKERFILE } from './docker';
import { NodeServerAdapter, deployDependencies } from './node-server';
import { getAdapter, registerBuiltInAdapters } from '../index';

function writeSpec(dir: string): string {
  const specPath = path.join(dir, 'agent.yaml');
  fs.writeFileSync(
    specPath,
    'name: docker-agent\nprompt: You are a containerized agent.\nprovider:\n  type: mock\n  model: mock-1\n'
  );
  return specPath;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DockerAdapter', () => {
  it("is registered as 'docker' and describes the docker build/run command", () => {
    registerBuiltInAdapters();
    expect(getAdapter('docker')).toBe(DockerAdapter);
    expect(DockerAdapter.describe('/anywhere')).toBe(
      'docker build -t lousho-agent . && docker run -p 3000:3000 lousho-agent'
    );
  });

  it('scaffold() delegates to NodeServerAdapter.scaffold() and adds a Dockerfile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docker-'));
    const specPath = writeSpec(dir);
    const outDir = path.join(dir, 'out');
    const spy = vi.spyOn(NodeServerAdapter, 'scaffold');

    await DockerAdapter.scaffold(specPath, outDir);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(specPath, outDir, undefined);
    // NodeServerAdapter's own outputs are there (written by it, not duplicated here)...
    for (const file of ['server.ts', 'agent.config.js', 'package.json']) {
      expect(fs.existsSync(path.join(outDir, file))).toBe(true);
    }
    // ...plus the Dockerfile.
    const dockerfile = fs.readFileSync(path.join(outDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toBe(DOCKERFILE);
    const lines = dockerfile.split('\n');
    expect(lines).toContain('FROM node:22-slim');
    expect(lines).toContain('WORKDIR /app');
    expect(lines).toContain('COPY dist/ ./dist/');
    expect(lines).toContain('COPY package.json ./');
    expect(lines).toContain('RUN npm install --omit=dev');
    expect(lines).toContain('EXPOSE 3000');
    expect(lines).toContain('CMD ["node", "dist/server.js"]');
    // Container needs an explicit all-interfaces opt-in to be reachable via -p.
    expect(lines).toContain('ENV HOST=0.0.0.0');
  });

  it('writes a package.json shipping the SDK and the peers the spec needs (LOU-R20)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docker-'));
    const specPath = path.join(dir, 'agent.yaml');
    fs.writeFileSync(
      specPath,
      'name: docker-agent\nprompt: p\nprovider:\n  type: openai\n  model: gpt-4o-mini\nmcpServers:\n  fs:\n    command: npx\n'
    );
    const outDir = path.join(dir, 'out');
    await DockerAdapter.scaffold(specPath, outDir);

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'));
    const sdk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    // The image's `npm install --omit=dev` must install what the bundle left external.
    expect(manifest.dependencies['@lousho/build-ai-agent']).toBe(sdk.version);
    expect(manifest.dependencies['@ai-sdk/openai']).toBeDefined();
    expect(manifest.dependencies['@modelcontextprotocol/sdk']).toBe(sdk.peerDependencies['@modelcontextprotocol/sdk']);
    expect(manifest.scripts.start).toBe('node dist/server.js');
  });

  it('a mock-provider spec ships only the SDK dependency', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docker-'));
    const outDir = path.join(dir, 'out');
    await DockerAdapter.scaffold(writeSpec(dir), outDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'));
    const sdk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual({ '@lousho/build-ai-agent': sdk.version });
  });

  it('an agent directory ships the provider peer its data config names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docker-'));
    const agentDir = path.join(dir, 'my-agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({ model: 'anthropic/claude-x', description: 'd' }));
    fs.writeFileSync(path.join(agentDir, 'instructions.md'), 'You help.');
    const outDir = path.join(dir, 'out');
    await DockerAdapter.scaffold(agentDir, outDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'));
    expect(manifest.dependencies['@ai-sdk/anthropic']).toBeDefined();
  });

  it('deployDependencies pairs the provider peer with the installed ai major', () => {
    const deps = deployDependencies('openai');
    expect(deps['@ai-sdk/openai']).toMatch(/^\^/);
    expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
    expect(deployDependencies('nope')).toEqual(deployDependencies());
    const ollamaMcp = deployDependencies('ollama', true);
    expect(Object.keys(ollamaMcp)).toHaveLength(3);
    expect(Object.keys(ollamaMcp).some((k) => k.startsWith('ollama-ai-provider'))).toBe(true);
    expect(ollamaMcp['@modelcontextprotocol/sdk']).toBeDefined();
  });

  it('build() delegates to NodeServerAdapter.build()', async () => {
    const spy = vi.spyOn(NodeServerAdapter, 'build').mockResolvedValue(undefined);
    await DockerAdapter.build('/some/out');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('/some/out');
  });
});
