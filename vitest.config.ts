import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.next` holds build artifacts (incl. a standalone copy of source +
    // tests) — never collect tests from there.
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
});
