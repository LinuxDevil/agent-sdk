/** N10a: the principal's types on the run context, memory scopes, send options and routes. */
import { describe, expectTypeOf, it } from 'vitest';
import { createAgent, type MemoryScopeContext, type Principal, type RunConfigContext, type SendOptions } from '../index';
import type { Principal as AuthPrincipal, AuthFn } from './index';
import { createRouteHandler, type RouteHandlerOptions } from '../server/routeHandler';
import { apiToken, basic, jwt } from './index';
import { createMockProvider } from '../providers/mock';

describe('Principal types (N10a)', () => {
  it('is one type at the root and on the auth subpath', () => {
    expectTypeOf<Principal>().toEqualTypeOf<AuthPrincipal>();
    expectTypeOf<Principal['type']>().toEqualTypeOf<'user' | 'service'>();
  });

  it('rides on RunConfigContext, MemoryScopeContext and SendOptions', () => {
    expectTypeOf<RunConfigContext['principal']>().toEqualTypeOf<Principal | undefined>();
    expectTypeOf<MemoryScopeContext['principal']>().toEqualTypeOf<Principal | undefined>();
    expectTypeOf<SendOptions['principal']>().toEqualTypeOf<Principal | undefined>();
    createAgent({
      provider: createMockProvider(),
      instructions: (ctx) => {
        expectTypeOf(ctx.principal).toEqualTypeOf<Principal | undefined>();
        return 'ok';
      },
    });
  });

  it("createRouteHandler's auth takes a token, a boolean function, an AuthFn or a list", () => {
    const agent = createAgent({ provider: createMockProvider() });
    createRouteHandler(agent, { auth: 'token' });
    createRouteHandler(agent, { auth: () => true });
    createRouteHandler(agent, { auth: apiToken('t') });
    createRouteHandler(agent, { auth: [jwt({ secret: 's'.repeat(32), audience: 'a' }), basic({ users: { a: 'b' } })] });
    expectTypeOf<AuthFn>().toMatchTypeOf<NonNullable<RouteHandlerOptions['auth']>>();
    // @ts-expect-error - an auth entry returns a Principal, null or undefined
    const bad: AuthFn = () => 'yes';
    void bad;
  });
});
