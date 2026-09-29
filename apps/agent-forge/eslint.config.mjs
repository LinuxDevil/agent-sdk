// Mirrors the root repo's eslint.config.mjs conventions (typescript-eslint
// recommended, no-explicit-any / no-unused-vars / ban-ts-comment downgraded
// to 'warn' rather than turned off) so this app's lint output stays
// consistent with `npm run lint` at the repo root, rather than inventing a
// divergent lint setup for this one workspace.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  }
);
