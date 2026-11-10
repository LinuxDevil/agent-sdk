import { describe, it, expect } from 'vitest';
import { narrowPolicy, workspacePolicySchema, type PolicyCeiling, type WorkspacePolicy } from './policy';

const marketing: WorkspacePolicy = {
  permissions: [
    { id: 'no-shell', tool: 'shell', action: 'deny', reason: 'No shell in Marketing' },
    { id: 'ask-publish', tool: 'publish_*', when: { channel: { eq: 'instagram' } }, action: 'ask', ttlMs: 3_600_000 },
  ],
  tools: { allow: ['render_video', 'synthesize_voice', 'search_facts', 'publish_*'] },
  secrets: [{ env: 'INSTAGRAM_TOKEN' }, { secret: 'brand-api-key' }],
  network: { allowHosts: ['graph.facebook.com', '*.cdn.example.com'] },
  approvals: { require: ['publish_*'] },
  sandbox: { mode: 'process' },
};

const wide: PolicyCeiling = {
  permissions: [{ id: 'allow-all', tool: '*', action: 'allow' }],
  tools: { allow: ['*'] },
  secrets: [{ env: 'INSTAGRAM_TOKEN' }, { secret: 'brand-api-key' }, { env: 'OTHER' }],
  network: { allowHosts: ['*.facebook.com', '*.example.com'] },
  approvals: { require: ['delete_*'] },
  sandbox: { mode: 'none' },
};

describe('workspacePolicySchema', () => {
  it('accepts the Marketing policy', () => {
    const result = workspacePolicySchema.safeParse(marketing);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(marketing);
  });

  it('accepts an empty policy', () => {
    expect(workspacePolicySchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ['an unknown key', { mcpServers: {} }],
    ['an unknown nested key', { tools: { allow: [], deny: [] } }],
    ['a tool allowlist without allow', { tools: {} }],
    ['a bad tool name', { tools: { allow: ['a b'] } }],
    ['a host with a scheme', { network: { allowHosts: ['https://example.com'] } }],
    ['a host with a port', { network: { allowHosts: ['example.com:8080'] } }],
    ['an upper-case host', { network: { allowHosts: ['Example.com'] } }],
    ['a bad secret ref', { secrets: [{ env: 'A', secret: 'b' }] }],
    ['a bad sandbox mode', { sandbox: { mode: 'vm' } }],
    ['a permission rule without an id', { permissions: [{ tool: 'shell', action: 'deny' }] }],
    ['an auto permission rule', { permissions: [{ id: 'a', tool: 'shell', action: 'auto' }] }],
  ])('rejects %s', (_name, value) => {
    expect(workspacePolicySchema.safeParse(value).success).toBe(false);
  });
});

describe('narrowPolicy', () => {
  it('never returns a tool, host or secret outside the ceiling', () => {
    const ceiling: PolicyCeiling = {
      tools: { allow: ['search_facts', 'github_*'] },
      network: { allowHosts: ['api.example.com', '*.cdn.example.com'] },
      secrets: [{ env: 'A' }, { secret: 'b' }],
    };
    const workspace: WorkspacePolicy = {
      tools: { allow: ['search_facts', 'shell', 'github_read', '*', 'github_*'] },
      network: { allowHosts: ['api.example.com', 'evil.com', 'a.cdn.example.com', '*.example.com', 'cdn.example.com', 'api.example.com.evil.com'] },
      secrets: [{ env: 'A' }, { env: 'b' }, { secret: 'A' }, { secret: 'c' }],
    };
    const result = narrowPolicy(ceiling, workspace);
    expect(result.tools.allow.sort()).toEqual(['github_*', 'github_read', 'search_facts']);
    expect(result.network.allowHosts.sort()).toEqual(['*.cdn.example.com', 'a.cdn.example.com', 'api.example.com']);
    expect(result.secrets).toEqual([{ env: 'A' }]);
  });

  it('keeps the ceiling entry a narrower workspace pattern covers', () => {
    const result = narrowPolicy(
      { tools: { allow: ['github_read', 'github_write', 'shell'] }, network: { allowHosts: ['a.example.com', 'b.other.com'] } },
      { tools: { allow: ['github_*'] }, network: { allowHosts: ['*.example.com'] } }
    );
    expect(result.tools.allow).toEqual(['github_read', 'github_write']);
    expect(result.network.allowHosts).toEqual(['a.example.com']);
  });

  it('does not let a wildcard host cover its own apex or a look-alike', () => {
    const result = narrowPolicy(
      { network: { allowHosts: ['*.example.com'] } },
      { network: { allowHosts: ['example.com', 'badexample.com', 'a.example.com.evil.com', 'x.y.example.com'] } }
    );
    expect(result.network.allowHosts).toEqual(['x.y.example.com']);
  });

  it('grants nothing when the ceiling omits a list, whatever the workspace asks for', () => {
    const result = narrowPolicy(
      {},
      { tools: { allow: ['shell'] }, network: { allowHosts: ['example.com'] }, secrets: [{ env: 'A' }] }
    );
    expect(result.tools.allow).toEqual([]);
    expect(result.network.allowHosts).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('grants nothing when both sides omit a list', () => {
    expect(narrowPolicy({}, {})).toEqual({
      permissions: [],
      tools: { allow: [] },
      secrets: [],
      network: { allowHosts: [] },
      approvals: { require: [] },
      sandbox: { mode: 'none' },
    });
  });

  it('inherits the ceiling lists when the workspace omits them', () => {
    const result = narrowPolicy(wide, {});
    expect(result.tools.allow).toEqual(['*']);
    expect(result.network.allowHosts).toEqual(['*.facebook.com', '*.example.com']);
    expect(result.secrets).toEqual(wide.secrets);
  });

  it('treats an explicit empty workspace list as granting nothing', () => {
    const result = narrowPolicy(wide, { tools: { allow: [] }, network: { allowHosts: [] }, secrets: [] });
    expect(result.tools.allow).toEqual([]);
    expect(result.network.allowHosts).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('treats an explicit empty ceiling list as granting nothing', () => {
    const result = narrowPolicy({ tools: { allow: [] }, network: { allowHosts: [] }, secrets: [] }, marketing);
    expect(result.tools.allow).toEqual([]);
    expect(result.network.allowHosts).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('narrows the Marketing policy under a wide ceiling', () => {
    const result = narrowPolicy(wide, marketing);
    expect(result.tools.allow).toEqual(['render_video', 'synthesize_voice', 'search_facts', 'publish_*']);
    expect(result.network.allowHosts).toEqual(['graph.facebook.com', '*.cdn.example.com']);
    expect(result.secrets).toEqual([{ env: 'INSTAGRAM_TOKEN' }, { secret: 'brand-api-key' }]);
  });

  it('removes duplicate entries', () => {
    const result = narrowPolicy(
      { tools: { allow: ['a', 'a'] }, secrets: [{ env: 'A' }] },
      { tools: { allow: ['a', 'a'] }, secrets: [{ env: 'A' }, { env: 'A' }] }
    );
    expect(result.tools.allow).toEqual(['a']);
    expect(result.secrets).toEqual([{ env: 'A' }]);
  });

  describe('permissions', () => {
    const allow = { id: 'c-allow', tool: 'shell', action: 'allow' } as const;
    const ceilingDeny = { id: 'c-deny', tool: 'rm', action: 'deny' } as const;
    const wsDeny = { id: 'w-deny', tool: 'shell', action: 'deny' } as const;
    const wsAsk = { id: 'w-ask', tool: 'shell', action: 'ask' } as const;
    const wsAllow = { id: 'w-allow', tool: 'rm', action: 'allow' } as const;

    it('a workspace deny holds under a ceiling allow', () => {
      const result = narrowPolicy({ permissions: [allow] }, { permissions: [wsDeny] });
      expect(result.permissions.map((rule) => rule.id)).toEqual(['w-deny', 'c-allow']);
      expect(result.permissions[0]).toMatchObject({ tool: 'shell', action: 'deny' });
    });

    it('puts a workspace deny ahead of an earlier ceiling allow with a condition', () => {
      const conditional = { id: 'c-ls', tool: 'shell', when: { command: '^ls' }, action: 'allow' } as const;
      const result = narrowPolicy({ permissions: [conditional] }, { permissions: [wsDeny] });
      expect(result.permissions.map((rule) => rule.id)).toEqual(['w-deny', 'c-ls']);
    });

    it('keeps the ceiling rules in their own order', () => {
      const result = narrowPolicy({ permissions: [allow, ceilingDeny] }, {});
      expect(result.permissions.map((rule) => rule.id)).toEqual(['c-allow', 'c-deny']);
    });

    it('drops workspace allow rules, which could only widen', () => {
      const result = narrowPolicy({ permissions: [ceilingDeny] }, { permissions: [wsAllow] });
      expect(result.permissions.map((rule) => rule.id)).toEqual(['c-deny']);
    });

    it('keeps a workspace ask behind the ceiling rules, so it cannot unlock a ceiling deny', () => {
      const result = narrowPolicy({ permissions: [{ id: 'c-deny-shell', tool: 'shell', action: 'deny' }] }, { permissions: [wsAsk] });
      expect(result.permissions.map((rule) => rule.id)).toEqual(['c-deny-shell', 'w-ask']);
    });

    it('applies a workspace deny and ask when the ceiling has no rules', () => {
      expect(narrowPolicy({}, { permissions: [wsAllow, wsAsk, wsDeny] }).permissions.map((rule) => rule.id)).toEqual(['w-deny', 'w-ask']);
    });

    it('is empty when neither side has rules', () => {
      expect(narrowPolicy({ permissions: [] }, { permissions: [] }).permissions).toEqual([]);
    });
  });

  describe('approvals', () => {
    it('only grows: the union of both sides', () => {
      const result = narrowPolicy({ approvals: { require: ['delete_*', 'pay'] } }, { approvals: { require: ['publish_*', 'pay'] } });
      expect(result.approvals.require).toEqual(['delete_*', 'pay', 'publish_*']);
    });

    it('keeps the ceiling requirements when the workspace has none', () => {
      expect(narrowPolicy({ approvals: { require: ['pay'] } }, {}).approvals.require).toEqual(['pay']);
      expect(narrowPolicy({ approvals: { require: ['pay'] } }, { approvals: { require: [] } }).approvals.require).toEqual(['pay']);
    });

    it('keeps the workspace requirements when the ceiling has none', () => {
      expect(narrowPolicy({}, { approvals: { require: ['pay'] } }).approvals.require).toEqual(['pay']);
      expect(narrowPolicy({ approvals: { require: [] } }, { approvals: { require: ['pay'] } }).approvals.require).toEqual(['pay']);
    });
  });

  describe('sandbox', () => {
    const modes = ['none', 'process', 'container'] as const;

    it.each(modes.flatMap((c) => modes.map((w) => [c, w] as const)))('ceiling %s with workspace %s gives the stricter', (c, w) => {
      const expected = modes[Math.max(modes.indexOf(c), modes.indexOf(w))];
      expect(narrowPolicy({ sandbox: { mode: c } }, { sandbox: { mode: w } }).sandbox.mode).toBe(expected);
    });

    it('keeps the ceiling mode when the workspace omits it', () => {
      expect(narrowPolicy({ sandbox: { mode: 'container' } }, {}).sandbox.mode).toBe('container');
    });

    it('lets the workspace tighten an absent ceiling mode', () => {
      expect(narrowPolicy({}, { sandbox: { mode: 'process' } }).sandbox.mode).toBe('process');
    });

    it('is none when both omit it', () => {
      expect(narrowPolicy({}, {}).sandbox.mode).toBe('none');
    });
  });

  describe('purity', () => {
    it('does not change its inputs and returns copies', () => {
      const ceiling = structuredClone(wide);
      const workspace = structuredClone(marketing);
      const result = narrowPolicy(ceiling, workspace);
      expect(ceiling).toEqual(wide);
      expect(workspace).toEqual(marketing);
      result.tools.allow.push('x');
      result.secrets.push({ env: 'X' });
      result.permissions.forEach((rule) => {
        rule.tool = 'x';
      });
      expect(ceiling).toEqual(wide);
      expect(workspace).toEqual(marketing);
    });

    it('gives the same result for the same inputs', () => {
      expect(narrowPolicy(wide, marketing)).toEqual(narrowPolicy(wide, marketing));
    });
  });
});
