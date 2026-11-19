// Test-only binding: the migrations read in vitest.config.ts, applied before each file.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('@cloudflare/vitest-plugin').D1Migration[];
  }
}
