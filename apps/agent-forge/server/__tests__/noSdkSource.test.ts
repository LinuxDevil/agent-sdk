/**
 * W14 (PLAN §19.7): Studio imports the SDK through its package exports only.
 * Exercises the `lousho/no-sdk-source` ESLint rule the `lint:imports` gate runs.
 */
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { noSdkSource } = require('../../eslintRules/noSdkSource.mjs') as {
  noSdkSource: import('eslint').Rule.RuleModule;
};

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appFile = (rel: string) => path.join(APP, rel);

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run('no-sdk-source', noSdkSource, {
  valid: [
    { code: "import { AgentExecutor } from 'lousho';", filename: appFile('server/x.ts') },
    { code: "import { agentSpecSchema } from 'lousho/spec';", filename: appFile('src/x.ts') },
    { code: "import { startObserveDaemon } from 'lousho/observe';", filename: appFile('server/__tests__/x.test.ts') },
    { code: "import type { ToolRef } from 'lousho/spec';", filename: appFile('src/graph/v2/specTypes.ts') },
    { code: "import { helper } from '../../state/AppState';", filename: appFile('src/screens/x.ts') },
    { code: "import { helper } from './local';", filename: appFile('server/x.ts') },
    { code: "vi.mock('../../state/AppState');", filename: appFile('src/screens/x.test.ts') },
    { code: "vi.mock('lousho/spec', () => ({}));", filename: appFile('src/x.test.ts') },
    // In-app relative specifiers that stay inside apps/agent-forge are fine.
    { code: "import { graphToSpec } from '../../src/graph/graphToSpec';", filename: appFile('server/__tests__/x.test.ts') },
  ],
  invalid: [
    {
      code: "import { x } from '../../../../src/index';",
      filename: appFile('server/__tests__/x.test.ts'),
      errors: [{ messageId: 'deep' }],
    },
    {
      code: "import { x } from '@lousho/build-ai-agent/dist/spec/schema';",
      filename: appFile('src/x.ts'),
      errors: [{ messageId: 'deep' }],
    },
    {
      code: "import { x } from 'lousho/src/spec/schema';",
      filename: appFile('src/x.ts'),
      errors: [{ messageId: 'deep' }],
    },
    {
      code: "const m = await import('../../../../src/y');",
      filename: appFile('server/__tests__/x.test.ts'),
      errors: [{ messageId: 'deep' }],
    },
    {
      code: "export * from '../../../../src/z';",
      filename: appFile('server/x.ts'),
      errors: [{ messageId: 'deep' }],
    },
    {
      code: "export { x } from '../../../../src/w';",
      filename: appFile('src/x.ts'),
      errors: [{ messageId: 'deep' }],
    },
    {
      code: "vi.mock('../../../../src/observe/daemon');",
      filename: appFile('server/__tests__/x.test.ts'),
      errors: [{ messageId: 'deep' }],
    },
    {
      code: "vi.importActual('../../../../src/store');",
      filename: appFile('server/__tests__/x.test.ts'),
      errors: [{ messageId: 'deep' }],
    },
  ],
});
