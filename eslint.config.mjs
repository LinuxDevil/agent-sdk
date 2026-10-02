// The pre-existing warning baseline was cleared in LOU-D16 (see
// docs/eslint-baseline-followup.md): these rules are errors, and `npm run lint`
// runs with --max-warnings 0 so no warning-level rule can accumulate either.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'examples/**', '**/__fixtures__/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // A targeted `eslint-disable-next-line <rule> -- <reason>` is allowed
      // only where a real type is not possible (e.g. a deprecated public type
      // kept for compatibility); never file-wide.
      '@typescript-eslint/no-explicit-any': 'error',
      // A leading underscore marks a parameter/variable kept on purpose (an
      // interface method that ignores an argument, a type-test stub).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/ban-ts-comment': 'error',
    },
  }
);
