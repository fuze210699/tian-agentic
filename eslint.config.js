import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import configPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    // src/ and demo/ run in the browser (the toolbar itself, plus the demo
    // app it's mounted into).
    files: ['src/**', 'demo/**'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // tests/e2e/run.mjs is a Node script that also passes inline callbacks
    // into page.evaluate() — those callbacks execute in the browser, so this
    // file legitimately references both Node and browser globals.
    files: ['tests/**'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    rules: {
      // Annotation context/helper fns intentionally take `Element`/DOM args
      // typed loosely in a few spots (e.g. composedPath()[0] as EventTarget).
      '@typescript-eslint/no-explicit-any': 'off',
      'vue/multi-word-component-names': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // persistKey/syncEndpoint/syncSessionId are meant to be left unset —
      // "no value" (pure client-side, no backend) is a real, intentional
      // mode, not a missing default to fill in.
      'vue/require-default-prop': 'off',
      // Every v-html use in this file renders a bundled SVG logo imported
      // via `?raw` from our own assets/ dir (claude/opencode/agent-ai icons)
      // — never user/annotation-controlled content, so there's no actual
      // XSS surface here.
      'vue/no-v-html': 'off',
    },
  },
  configPrettier
);
