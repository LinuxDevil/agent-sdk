// Remaining baseline lint violations are tracked as intra-repo follow-up in
// docs/eslint-baseline-followup.md (see LOU-B1).
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'examples/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
  }
);
