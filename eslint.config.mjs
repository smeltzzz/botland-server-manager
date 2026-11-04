import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const tsFiles = ['src/**/*.{ts,tsx}', 'vite.config.ts'];

export default [
  { ignores: ['dist/**', 'release/**', 'node_modules/**'] },
  {
    ...js.configs.recommended,
    files: ['electron/**/*.cjs', 'scripts/**/*.cjs', 'tests/**/*.cjs', 'eslint.config.mjs'],
    languageOptions: { globals: globals.node },
    // Existing Electron errors are translated to safe, user-facing messages.
    rules: { 'preserve-caught-error': 'off' },
  },
  // Config validation intentionally matches NUL/control characters in user input.
  { files: ['electron/config.cjs'], rules: { 'no-control-regex': 'off' } },
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: tsFiles,
    languageOptions: { ...config.languageOptions, globals: { ...globals.browser, ...globals.node } },
  })),
  // Prettier is opt-in for existing files; disable only rules that conflict with it.
  prettier,
];
