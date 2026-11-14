module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    'no-console': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-floating-promises': 'off',
    'no-debugger': 'error',
    eqeqeq: ['error', 'always'],
  },
  overrides: [
    {
      // Preserve the browser render-error and React component stack for support.
      files: ['apps/web/src/components/shared/ErrorBoundary.tsx'],
      rules: { 'no-console': ['error', { allow: ['error'] }] },
    },
    {
      // Operator scripts run from a terminal and are read by a person standing
      // in front of it. `no-console` is there to stop server code logging
      // outside the structured logger; printing is what these are for.
      files: ['**/src/scripts/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
  ignorePatterns: [
    'node_modules',
    'dist',
    '.turbo',
    'coverage',
    '*.config.js',
    '*.config.ts',
    '.eslintrc.js',
  ],
};
