import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.tmp/**` is where AGENTS.md sends temporary files and scripts, so whatever
  // is in there is not this project's code — a stray coverage report left in it
  // was being linted.
  { ignores: ['dist/**', 'node_modules/**', 'demo/dist/**', 'explorer/dist/**', 'coverage/**', '.tmp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
