# Backend test suite

92 tests across 6 files, run against a **real MongoDB** — not mocks — because
almost every bug these tests guard is a database-behaviour bug: atomicity,
index constraints, cursor semantics, transaction boundaries. A mocked driver
would have happily passed the buggy code.

```bash
npm test          # one run
npm run test:watch
```

## Requirement: the database must be a replica set

MongoDB transactions are **only** available on a replica set or a sharded
cluster. The Phase 4A fixes use `session.withTransaction()` for every
multi-document write, so a standalone `mongod` cannot run this suite — and,
more importantly, cannot run the application correctly either.

A default local install is standalone. Production is fine: MongoDB Atlas is
always a replica set, including the free tier.

`tests/helpers.ts` fails fast with an explicit message rather than letting
every transactional test die on a cryptic driver error.

### Option A — a throwaway replica set for tests (no change to your machine)

```bash
mkdir -p /tmp/finzz-test-db
mongod --replSet rs0 --port 27018 --dbpath /tmp/finzz-test-db --bind_ip 127.0.0.1
```

Then once, from any Node shell:

```js
new (require('mongodb').MongoClient)('mongodb://127.0.0.1:27018/?directConnection=true')
  .connect().then(c => c.db('admin').command({
    replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27018' }] }
  }));
```

This is what the suite defaults to (`127.0.0.1:27018`).

### Option B — convert your permanent local mongod to a single-node replica set

Recommended for day-to-day development, because it makes local behaviour match
production. **Non-destructive: existing data is preserved.**

Add to `mongod.cfg`:

```yaml
replication:
  replSetName: rs0
```

Restart the MongoDB service, then run `rs.initiate()` once. Point the suite at
it with `TEST_MONGO_URL=mongodb://127.0.0.1:27017/finzz_test`.

Until this is done, `withTransaction` will fail at runtime in local dev with
`Transaction numbers are only allowed on a replica set member or mongos`.

## Safety

- `tests/setup.ts` **refuses to run** against any host that is not
  `127.0.0.1`/`localhost`. The suite truncates collections between tests, so
  pointing it at Atlas would destroy production data.
- Test env vars are set in `setup.ts`; your `.env` is not used for secrets.
- The mailer is replaced by an in-memory mailbox (`tests/mailbox.ts`), so no
  real email is ever sent and the suite can read the OTP a user would receive.

## Layout

| File | Covers |
|---|---|
| `auth.test.ts` | Admin token payload/expiry, token type claims, the legacy grace period, refresh rotation and revocation, multi-device sessions, enumeration |
| `validation.test.ts` | `validate()` applying its parsed result, mass-assignment stripping, money coercion, NoSQL operator injection, ledger close guard, regex escaping, route ordering |
| `integrity.test.ts` | Cursor tie-breaking, concurrent ledger writes, ledger/expense transactions, cross-month edits, duplicate chats, the full delete cascade |
| `authorization.test.ts` | The chat-stats IDOR, transaction ownership, participant re-validation on edit, admin role separation |
| `otp.test.ts` | Code format and entropy, attempt counter, no sentinel users, verification required for registration, reset flow, TTL index |
| `security.test.ts` | HTML/regex/cursor/date unit tests, XSS end-to-end through the real export, helmet headers, body limits |

## Notes on approach

**The mailbox seam.** OTPs are stored as bcrypt hashes and the plaintext only
leaves the server by email — correct, and it means a test cannot read the code
it must submit. Intercepting the mailer keeps the generator and the hashing
under test exactly as they ship, and mirrors how a real user obtains a code.
The alternative — weakening production code to expose the plaintext — would
have removed the thing being tested.

**Serial execution.** `fileParallelism: false`, because the suite truncates
shared collections. Parallel files would clear each other's fixtures mid-assertion.

**Tests are named after their finding IDs** (`BE-006`, `BE-018`, …) so a
failure points directly at the audit entry explaining what broke and why.
