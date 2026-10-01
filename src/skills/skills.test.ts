import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { AgentExecutor } from '../execution/AgentExecutor';
import { AgentBuilder } from '../core/AgentBuilder';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools/ToolRegistry';
import { mockModel } from '../testing';
import { defineSkill, loadSkills } from './index';

const changelog = defineSkill({
  name: 'changelog',
  description: 'How to write a changelog entry',
  content: '# Changelog\nSECRET-CHANGELOG-BODY: use the imperative mood.',
});
const review = defineSkill({
  name: 'code_review',
  description: 'How to review a pull request',
  content: 'SECRET-REVIEW-BODY',
});

const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }): string =>
  String(call.messages.find((m) => m.role === 'system')?.content);

describe('defineSkill', () => {
  it('returns the skill', () => {
    expect(changelog).toEqual({
      name: 'changelog',
      description: 'How to write a changelog entry',
      content: '# Changelog\nSECRET-CHANGELOG-BODY: use the imperative mood.',
    });
  });

  it('rejects bad names with a suggested fix', () => {
    expect(() => defineSkill({ name: 'My Skill!', description: 'd', content: 'c' })).toThrow(
      /invalid skill name "My Skill!".*e\.g\. "my-skill-"/
    );
    expect(() => defineSkill({ name: '', description: 'd', content: 'c' })).toThrow(/'name' is required/);
    expect(() => defineSkill({ name: 'a'.repeat(65), description: 'd', content: 'c' })).toThrow(/invalid skill name/);
    expect(() => defineSkill({ name: '-x', description: 'd', content: 'c' })).toThrow(/invalid skill name/);
  });

  it('rejects empty description and content', () => {
    expect(() => defineSkill({ name: 'x', description: ' ', content: 'c' })).toThrow(
      /skill 'x' is missing a non-empty 'description'.*Example/
    );
    expect(() => defineSkill({ name: 'x', description: 'd', content: '' })).toThrow(/non-empty 'content'/);
    expect(() => defineSkill(undefined as never)).toThrow(/'name' is required/);
  });
});

describe('skills wiring (createAgent)', () => {
  it('lists skills by description without bodies, then returns the body via load_skill', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'load_skill', args: { name: 'changelog' } }] },
      'Done.',
    ]);
    const agent = createAgent({
      prompt: 'You are a release engineer.',
      provider: model,
      skills: [changelog, review],
    });

    const result = await agent.send('write a changelog');

    expect(result.text).toBe('Done.');
    const first = model.calls[0];
    const system = systemOf(first);
    expect(system).toContain('You are a release engineer.');
    expect(system).toContain('- changelog: How to write a changelog entry');
    expect(system).toContain('- code_review: How to review a pull request');
    expect(system).toContain('`load_skill`');
    expect(system).not.toContain('SECRET-CHANGELOG-BODY');
    expect(system).not.toContain('SECRET-REVIEW-BODY');
    expect(first.tools?.map((t) => t.function.name)).toEqual(['load_skill']);

    const second = model.calls[1];
    const toolMessage = second.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('SECRET-CHANGELOG-BODY');
    expect(systemOf(second)).not.toContain('SECRET-CHANGELOG-BODY');
    expect(JSON.stringify(second.messages)).not.toContain('SECRET-REVIEW-BODY');
  });

  it('returns a tool error listing valid names for an unknown skill', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'load_skill', args: { name: 'nope' } }] },
      'ok',
    ]);
    await createAgent({ prompt: 'p', provider: model, skills: [changelog, review] }).send('go');

    const toolMessage = model.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ isError: true, toolName: 'load_skill' });
    expect(toolMessage?.content).toContain("Unknown skill 'nope'");
    expect(toolMessage?.content).toContain('changelog, code_review');
  });

  it('keeps the user tools alongside load_skill', async () => {
    const ping = defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: () => 'pong' });
    const model = mockModel(['hi']);
    await createAgent({ prompt: 'p', provider: model, tools: [ping], skills: [changelog] }).send('x');
    expect(model.calls[0].tools?.map((t) => t.function.name).sort()).toEqual(['load_skill', 'ping']);
  });

  it('adds no skills block or tool when no skills are given', async () => {
    const model = mockModel(['hi']);
    await createAgent({ prompt: 'plain', provider: model, skills: [] }).send('x');
    expect(systemOf(model.calls[0])).toBe('plain');
    expect(model.calls[0].tools ?? []).toEqual([]);
  });

  it('throws when the user already registered load_skill', () => {
    const own = defineTool({ name: 'load_skill', description: 'mine', input: z.object({}), execute: () => 1 });
    const agent = createAgent({ prompt: 'p', provider: mockModel(['x']), tools: [own], skills: [changelog] });
    return expect(agent.send('x')).rejects.toThrow(/'load_skill' is already registered/);
  });

  it('throws on duplicate skill names', async () => {
    const agent = createAgent({ prompt: 'p', provider: mockModel(['x']), skills: [changelog, changelog] });
    await expect(agent.send('x')).rejects.toThrow(/duplicate skill name 'changelog'/);
  });
});

describe('skills wiring (AgentExecutor.execute)', () => {
  it('supports the skills option without mutating the caller registry or agent', async () => {
    const model = mockModel(['hi']);
    const agent = AgentBuilder.create().setName('a').setPrompt('base').build();
    const registry = new ToolRegistry();

    await AgentExecutor.execute({ agent, input: 'x', provider: model, toolRegistry: registry, skills: [review] });

    expect(systemOf(model.calls[0])).toContain('- code_review: How to review a pull request');
    expect(agent.prompt).toBe('base');
    expect(registry.has('load_skill')).toBe(false);
  });

  it('uses the block alone when the agent has no prompt', async () => {
    const model = mockModel(['hi']);
    const agent = AgentBuilder.create().setName('a').build();
    await AgentExecutor.execute({ agent, input: 'x', provider: model, skills: [review] });
    expect(systemOf(model.calls[0]).startsWith('## Available skills')).toBe(true);
  });
});

describe('loadSkills', () => {
  let dir: string;
  const write = async (rel: string, content: string) => {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads both layouts sorted by name, defaulting names from folder/file', async () => {
    await write('zeta/SKILL.md', '---\ndescription: Zeta skill\n---\n\nZeta body\n');
    await write('alpha.md', '---\ndescription: Alpha skill\n---\nAlpha body');
    await write('mid/SKILL.md', '---\r\nname: renamed\r\ndescription: "Mid: skill"\r\n---\r\nMid body');
    await write('notes/README.txt', 'not a skill');
    await write('empty-dir/.gitkeep', '');

    const skills = await loadSkills(dir);

    expect(skills).toEqual([
      { name: 'alpha', description: 'Alpha skill', content: 'Alpha body' },
      { name: 'renamed', description: 'Mid: skill', content: 'Mid body' },
      { name: 'zeta', description: 'Zeta skill', content: 'Zeta body' },
    ]);
  });

  it('names the file when the description is missing', async () => {
    const file = await write('a.md', '# no frontmatter at all');
    await expect(loadSkills(dir)).rejects.toThrow(
      new RegExp(`${file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}: missing 'description'`)
    );
    await write('a.md', '---\nname: a\n---\nbody');
    await expect(loadSkills(dir)).rejects.toThrow(/missing 'description'/);
  });

  it('names the file for invalid YAML, non-mapping frontmatter and invalid names', async () => {
    await write('a.md', '---\ndescription: [unclosed\n---\nbody');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: invalid YAML frontmatter/);
    await write('a.md', '---\n- a\n- b\n---\nbody');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: frontmatter must be a YAML mapping/);
    await write('a.md', '---\nname: Bad Name\ndescription: d\n---\nbody');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: invalid skill name "Bad Name"/);
    await write('a.md', '---\ndescription: d\n---\n');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: skill 'a' is missing a non-empty 'content'/);
  });

  it('reports duplicate names with both paths', async () => {
    const a = await write('dup/SKILL.md', '---\ndescription: one\n---\nA');
    const b = await write('dup2.md', '---\nname: dup\ndescription: two\n---\nB');
    const error = await loadSkills(dir).then(
      () => undefined,
      (e: Error) => e
    );
    expect(error?.message).toMatch(/duplicate skill name 'dup'/);
    expect(error?.message).toContain(a);
    expect(error?.message).toContain(b);
  });

  it('reports an unreadable directory', async () => {
    await expect(loadSkills(path.join(dir, 'missing'))).rejects.toThrow(/cannot read skills directory/);
  });

  it('loaded skills work end to end', async () => {
    await write('release/SKILL.md', '---\ndescription: Cut a release\n---\nRELEASE-BODY');
    const model = mockModel([{ toolCalls: [{ name: 'load_skill', args: { name: 'release' } }] }, 'ok']);
    await createAgent({ prompt: 'p', provider: model, skills: await loadSkills(dir) }).send('go');
    expect(systemOf(model.calls[0])).toContain('- release: Cut a release');
    expect(model.calls[1].messages.find((m) => m.role === 'tool')?.content).toContain('RELEASE-BODY');
  });
});
