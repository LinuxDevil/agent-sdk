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
  sandbox: { required: true },
};

const wide: PolicyCeiling = {
  permissions: [{ id: 'allow-all', tool: '*', action: 'allow' }],
  tools: { allow: ['*'] },
  secrets: [{ env: 'INSTAGRAM_TOKEN' }, { secret: 'brand-api-key' }, { env: 'OTHER' }],
  network: { allowHosts: ['*.facebook.com', '*.example.com'] },
  approvals: { require: ['delete_*'] },
  sandbox: { required: false },
};

const empty: WorkspacePolicy = { permissions: [], tools: { allow: [] }, secrets: [] };

function policy(overrides: Partial<WorkspacePolicy>): WorkspacePolicy {
  return { ...empty, ...overrides };
}

describe('policy schema', () => {
  it('accepts the Marketing policy', () => {
    const result = workspacePolicySchema.safeParse(marketing);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(marketing);
  });

  it('accepts a policy with only the required fields', () => {
    expect(workspacePolicySchema.safeParse(empty).success).toBe(true);
  });

  it('accepts an auto permission rule (R01: auto compiles to ask and is model-decided)', () => {
    const result = workspacePolicySchema.safeParse(policy({ permissions: [{ id: 'a', tool: 'shell', action: 'auto' }] }));
    expect(result.success).toBe(true);
  });

  it.each([
    ['an empty object', {}],
    ['a missing permissions list', { tools: { allow: [] }, secrets: [] }],
    ['a missing tools allowlist', { permissions: [], secrets: [] }],
    ['a missing secrets list', { permissions: [], tools: { allow: [] } }],
    ['an unknown key', { ...empty, mcpServers: {} }],
    ['an unknown nested key', { ...empty, tools: { allow: [], deny: [] } }],
    ['a tools object without allow', { ...empty, tools: {} }],
    ['a bad tool name', { ...empty, tools: { allow: ['a b'] } }],
    ['a host with a scheme', { ...empty, network: { allowHosts: ['https://example.com'] } }],
    ['a host with a port', { ...empty, network: { allowHosts: ['example.com:8080'] } }],
    ['an upper-case host', { ...empty, network: { allowHosts: ['Example.com'] } }],
    ['a bare wildcard host', { ...empty, network: { allowHosts: ['*'] } }],
    ['a bad secret ref', { ...empty, secrets: [{ env: 'A', secret: 'b' }] }],
    ['a sandbox mode', { ...empty, sandbox: { mode: 'container' } }],
    ['a non-boolean sandbox flag', { ...empty, sandbox: { required: 'yes' } }],
    ['a permission rule without an id', { ...empty, permissions: [{ tool: 'shell', action: 'deny' }] }],
  ])('rejects %s', (_name, value) => {
    expect(workspacePolicySchema.safeParse(value).success).toBe(false);
  });
});

describe('narrowPolicy', () => {
  it('never returns a tool, host or secret outside the ceiling', () => {
    const ceiling = policy({
      tools: { allow: ['search_facts', 'github_*'] },
      network: { allowHosts: ['api.example.com', '*.cdn.example.com'] },
      secrets: [{ env: 'A' }, { secret: 'b' }],
    });
    const workspace = policy({
      tools: { allow: ['search_facts', 'shell', 'github_read', '*', 'github_*'] },
      network: { allowHosts: ['api.example.com', 'evil.com', 'a.cdn.example.com', '*.example.com', 'cdn.example.com', 'api.example.com.evil.com'] },
      secrets: [{ env: 'A' }, { env: 'b' }, { secret: 'A' }, { secret: 'c' }],
    });
    const result = narrowPolicy(ceiling, workspace);
    expect(result.tools.allow.sort()).toEqual(['github_*', 'github_read', 'search_facts']);
    expect(result.network.allowHosts.sort()).toEqual(['*.cdn.example.com', 'a.cdn.example.com', 'api.example.com']);
    expect(result.secrets).toEqual([{ env: 'A' }]);
  });

  it('keeps the ceiling entry a narrower workspace pattern covers', () => {
    const result = narrowPolicy(
      policy({ tools: { allow: ['github_read', 'github_write', 'shell'] }, network: { allowHosts: ['a.example.com', 'b.other.com'] } }),
      policy({ tools: { allow: ['github_*'] }, network: { allowHosts: ['*.example.com'] } })
    );
    expect(result.tools.allow).toEqual(['github_read', 'github_write']);
    expect(result.network.allowHosts).toEqual(['a.example.com']);
  });

  it('does not let a wildcard host cover its own apex or a look-alike', () => {
    const result = narrowPolicy(
      policy({ network: { allowHosts: ['*.example.com'] } }),
      policy({ network: { allowHosts: ['example.com', 'badexample.com', 'a.example.com.evil.com', 'x.y.example.com'] } })
    );
    expect(result.network.allowHosts).toEqual(['x.y.example.com']);
  });

  it('grants nothing when the ceiling lists nothing', () => {
    const result = narrowPolicy(empty, policy({ tools: { allow: ['shell'] }, network: { allowHosts: ['example.com'] }, secrets: [{ env: 'A' }] }));
    expect(result.tools.allow).toEqual([]);
    expect(result.network.allowHosts).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('grants nothing when both sides list nothing', () => {
    expect(narrowPolicy(empty, empty)).toEqual({
      permissions: { ceiling: [], workspace: [] },
      tools: { allow: [] },
      secrets: [],
      network: { allowHosts: [] },
      approvals: { require: [] },
      sandbox: { required: false },
    });
  });

  it('inherits the ceiling hosts when the workspace has no network section', () => {
    expect(narrowPolicy(wide, empty).network.allowHosts).toEqual(['*.facebook.com', '*.example.com']);
  });

  it('grants no hosts when the workspace lists none', () => {
    expect(narrowPolicy(wide, policy({ network: { allowHosts: [] } })).network.allowHosts).toEqual([]);
  });

  it('grants no hosts when the ceiling has no network section', () => {
    expect(narrowPolicy(empty, marketing).network.allowHosts).toEqual([]);
  });

  it('grants nothing when the workspace lists no tools or secrets', () => {
    const result = narrowPolicy(wide, empty);
    expect(result.tools.allow).toEqual([]);
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
      policy({ tools: { allow: ['a', 'a'] }, secrets: [{ env: 'A' }] }),
      policy({ tools: { allow: ['a', 'a'] }, secrets: [{ env: 'A' }, { env: 'A' }] })
    );
    expect(result.tools.allow).toEqual(['a']);
    expect(result.secrets).toEqual([{ env: 'A' }]);
  });

  it('throws on an invalid workspace policy', () => {
    expect(() => narrowPolicy(wide, { ...marketing, tools: { allow: ['a b'] } })).toThrow();
  });

  it('throws on an invalid ceiling, so a typo fails closed', () => {
    expect(() => narrowPolicy({ ...wide, network: { allowHosts: ['https://x.com'] } }, marketing)).toThrow();
    expect(() => narrowPolicy({ tools: { allow: ['*'] } } as unknown as PolicyCeiling, marketing)).toThrow();
  });

  describe('permissions', () => {
    const ceilingAllow = { id: 'c-allow', tool: 'shell', action: 'allow' } as const;
    const ceilingDeny = { id: 'c-deny', tool: 'rm', action: 'deny' } as const;
    const wsDeny = { id: 'w-deny', tool: 'shell', action: 'deny' } as const;
    const wsAsk = { id: 'w-ask', tool: 'shell', action: 'ask' } as const;
    const wsAllow = { id: 'w-allow', tool: 'rm', action: 'allow' } as const;
    const ids = (rules: readonly { id: string }[]) => rules.map((rule) => rule.id);

    it('keeps the layers apart: the ceiling unchanged and the workspace rules without its allows', () => {
      const result = narrowPolicy(policy({ permissions: [ceilingAllow, ceilingDeny] }), policy({ permissions: [wsAllow, wsDeny, wsAsk] }));
      expect(ids(result.permissions.ceiling)).toEqual(['c-allow', 'c-deny']);
      expect(ids(result.permissions.workspace)).toEqual(['w-deny', 'w-ask']);
    });

    it('a workspace deny holds under a ceiling allow', () => {
      const result = narrowPolicy(policy({ permissions: [ceilingAllow] }), policy({ permissions: [wsDeny] }));
      expect(result.permissions.workspace).toEqual([wsDeny]);
      expect(result.permissions.ceiling).toEqual([ceilingAllow]);
    });

    it('a workspace ask survives a wide ceiling allow-all and no workspace allow does', () => {
      const result = narrowPolicy(wide, policy({ permissions: [...marketing.permissions, wsAllow] }));
      expect(result.permissions.ceiling).toEqual(wide.permissions);
      expect(ids(result.permissions.workspace)).toEqual(['no-shell', 'ask-publish']);
      expect(result.permissions.workspace.some((rule) => rule.action === 'allow')).toBe(false);
    });

    it('is empty on both sides when neither has rules', () => {
      expect(narrowPolicy(empty, empty).permissions).toEqual({ ceiling: [], workspace: [] });
    });

    it('keeps workspace rules when the ceiling has none', () => {
      expect(ids(narrowPolicy(empty, policy({ permissions: [wsAllow, wsAsk, wsDeny] })).permissions.workspace)).toEqual(['w-ask', 'w-deny']);
    });
  });

  describe('approvals', () => {
    it('only grows: the union of both sides', () => {
      const result = narrowPolicy(policy({ approvals: { require: ['delete_*', 'pay'] } }), policy({ approvals: { require: ['publish_*', 'pay'] } }));
      expect(result.approvals.require).toEqual(['delete_*', 'pay', 'publish_*']);
    });

    it('keeps the ceiling requirements when the workspace has none', () => {
      expect(narrowPolicy(policy({ approvals: { require: ['pay'] } }), empty).approvals.require).toEqual(['pay']);
      expect(narrowPolicy(policy({ approvals: { require: ['pay'] } }), policy({ approvals: { require: [] } })).approvals.require).toEqual(['pay']);
    });

    it('keeps the workspace requirements when the ceiling has none', () => {
      expect(narrowPolicy(empty, policy({ approvals: { require: ['pay'] } })).approvals.require).toEqual(['pay']);
      expect(narrowPolicy(policy({ approvals: { require: [] } }), policy({ approvals: { require: ['pay'] } })).approvals.require).toEqual(['pay']);
    });
  });

  describe('sandbox', () => {
    const states = [undefined, false, true] as const;
    const sandboxOf = (required: boolean | undefined) => (required === undefined ? {} : { sandbox: { required } });

    it.each(states.flatMap((c) => states.map((w) => [c, w] as const)))('ceiling %s with workspace %s requires it only if either does', (c, w) => {
      const result = narrowPolicy(policy(sandboxOf(c)), policy(sandboxOf(w)));
      expect(result.sandbox.required).toBe(c === true || w === true);
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
      result.permissions.workspace.forEach((rule) => {
        rule.tool = 'x';
      });
      result.permissions.ceiling.forEach((rule) => {
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
