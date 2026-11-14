// Minimal flat config for `npm run lint:imports`: the TypeScript parser and
// only the no-sdk-source rule, so CI can gate on it without the rest of the
// Studio lint debt (PLAN §19.7 — Studio imports only public SDK exports).
import tseslint from 'typescript-eslint';
import { noSdkSource } from './eslintRules/noSdkSource.mjs';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['{src,server,shared,e2e}/**/*.{ts,tsx,mjs}'],
    languageOptions: { parser: tseslint.parser },
    // This gate runs one rule; disables aimed at rules it does not enable
    // are none of its business.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    // The plugin is registered (not its rules) so inline
    // `eslint-disable @typescript-eslint/...` comments still resolve.
    plugins: { '@typescript-eslint': tseslint.plugin, lousho: { rules: { 'no-sdk-source': noSdkSource } } },
    rules: { '@linuxdevil/lousho/no-sdk-source': 'error' },
  },
];
