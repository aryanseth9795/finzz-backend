/**
 * Test environment bootstrap.
 *
 * Loaded by vitest BEFORE any application module, because `envVariables.ts`
 * validates its inputs at import time and throws when they are missing — which
 * is the behaviour we want in production and must satisfy here.
 *
 * MONGO_URL points at a LOCAL, DISPOSABLE database. It must never point at
 * Atlas: this suite truncates collections between tests.
 */

const TEST_MONGO_URL =
  process.env.TEST_MONGO_URL ||
  "mongodb://127.0.0.1:27018/finzz_test?directConnection=true";

if (!/127\.0\.0\.1|localhost/.test(TEST_MONGO_URL)) {
  throw new Error(
    `Refusing to run tests against a non-local database: ${TEST_MONGO_URL}`,
  );
}

process.env.NODE_ENV = "test";
process.env.MONGO_URL = TEST_MONGO_URL;
process.env.JWT_SECRET =
  "test-jwt-secret-that-is-definitely-at-least-32-chars-long";
process.env.ADMIN_SECRET_KEY = "test-admin-secret-key-24-plus-chars";
process.env.RESEND_API = "";
process.env.PORT = "0";
process.env.API_URL = "";
// Effectively disable the global limiter so functional tests are not throttled.
// The rate-limit tests set their own expectations against the tiered limiters.
process.env.RATE_LIMIT_WINDOW_MS = "900000";
process.env.RATE_LIMIT_MAX_REQUESTS = "100000";
