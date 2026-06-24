// ---------------------------------------------------------------------------
// ESLint flat config (ESLint 9+) for @vectros-ai/mcp-server.
//
// Self-contained (each public package carries its own config — they ship as
// independent GitHub repos, so a shared base outside the package tree would not
// resolve after a fork). Kept consistent with the sibling public packages:
// typescript-eslint recommended + consistent-type-imports + an underscore-aware
// unused-vars guard. No react/JSX or browser rules — these are Node libraries.
// ---------------------------------------------------------------------------
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests lean on `any` for SDK/mock casts and the inline `import('..').Type`
    // form for one-off narrow shapes — both fine in test scaffolding.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
