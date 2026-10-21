# Review checklist

Load the fixed severities always, and only the other sections that match the diff.

Each rule has a stable ID: a finding cites it in brackets (`[SEV-03]`). A removed rule's ID is never reused: it moves to the line below, and a new rule takes the number after the highest its section has ever used.

Retired IDs: none.

## Fixed severities

These don't move with the author's arguments or with how common the pattern is in the repo.

| ID | Finding | Severity |
|---|---|---|
| SEV-01 | Secret, key or credential in code, config, logs, tests, a build argument, an image or a client bundle | Critical |
| SEV-02 | Injection, missing authorization or authentication check, unsafe deserialization | Critical |
| SEV-03 | Money or data loss: float money, lost update, missing idempotency or transaction on a write path | Critical |
| SEV-04 | A test weakened, deleted or skipped to get green, or changed in a way test-standard's "Changing tests" doesn't allow | Critical |
| SEV-05 | A focused test (`.only`, `fit`, `@only`) committed | Critical |
| SEV-06 | A CI check removed, skipped, set to continue on error, or given retries; retries in a test runner or end-to-end config | Critical |
| SEV-07 | Placeholder code in shipped paths: `TODO: implement`, stub returns, `throw new Error("not implemented")`, commented-out logic | Critical |
| SEV-08 | Suppressed type or lint errors without a written reason: `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `@Suppress`, `# type: ignore`, `//nolint`, `@SuppressLint` | Critical |
| SEV-09 | Personal or payment data in logs at info or above, even masked | Critical |
| SEV-10 | Destructive schema change without expand/contract or a recovery path; an applied migration edited | Critical |
| SEV-11 | A numbered criterion without a test, or with a manual check where automation is possible or the user didn't agree to it | Important |
| SEV-12 | A plan's Review focus line without a test | Important |
| SEV-13 | A test without an assertion or one asserting mock echo; an expected value copied from the code's output or recomputed with its algorithm (outside a marked characterization test) | Important |
| SEV-14 | A test-only helper, flag or hook in production code (except a provider fake or flag override that configuration selects and a startup check refuses in production) | Important |
| SEV-15 | A fixed sleep in a test; a real network call outside the provider-sandbox suite | Important |
| SEV-16 | A `test-hygiene: allow` that hides a forbidden skip, retry or sleep without the user's agreement | Same as the pattern it hides |
| SEV-17 | Payments without a test against the provider sandbox; POS without a list of what ran on real hardware | Important |
| SEV-18 | An outbound call, queue or database wait without a deadline | Important |
| SEV-19 | Environment read outside the config module, or configuration not validated at startup | Important |
| SEV-20 | A service or worker that exits without draining in-flight work on SIGTERM | Important |
| SEV-21 | A verification command that runs locally but not in CI | Important |
| SEV-22 | A metric label from an unbounded set (ids, URLs, messages); dynamic log messages instead of fields | Important |
| SEV-23 | Docs the change made stale | Important |
| SEV-24 | A project rule broken (agent manifest, path rule, decision record) | Important |
| SEV-25 | A payment, or its status, shown optimistically before the server confirms | Critical |
| SEV-26 | A failed optimistic update rolled back silently | Important |
| SEV-27 | Motion on a frequent or keyboard action, ease-in on UI, scaling from 0, animated layout properties, or no reduced-motion handling (ui-motion) | Important |
| SEV-28 | Breaking change (API, schema, config, CLI) not called out in the PR and changelog | Important |
| SEV-29 | New function over ~100 lines or new file over ~1000 lines | Important |
| SEV-30 | Naming, readability, small duplication | Minor |

## Correctness
- COR-01 Wrong variable (shadowed, copy-pasted, from an outer scope); off-by-one errors; inverted conditions.
- COR-02 Null or undefined, empty collections, empty strings, whitespace, case sensitivity, unicode, time zones and DST.
- COR-03 Shared mutable state under concurrency: races, missing locks or transactions, non-atomic read-modify-write.
- COR-04 Serialization drift between producer and consumer: missing fields, enum mismatch, `undefined` vs `null`, number precision.
- COR-05 Error paths: swallowed exceptions, partial writes without rollback, retries without idempotency.
- COR-06 Resource leaks: unclosed handles, listeners or timers, unbounded caches or queues.
- COR-07 Performance: I/O or queries in a loop (N+1), quadratic scans where a Map or Set would do, unbounded result sets without pagination.

## Tests
Check the diff against `../../test-driven-development/references/test-standard.md`, the single source of the test rules; the fixed severities above rate what it finds. In particular:
- TST-01 each criterion is verified as "Criteria and levels" says, and its new tests were seen failing first as the standard defines it (the PR or report says how);
- TST-02 layers don't repeat each other: a unit test asserting the user-level outcome a scenario already proves (the same journey, the same entry point) is a finding; unit tests of a unit's own contract are not, even on the happy path;
- TST-03 determinism and isolation: controlled clock and randomness, own data per test, cleanup registered where data is created, no shared mutable state;
- TST-04 with BDD, each scenario-verified criterion of the task has exactly one scenario tagged with it among the scenarios the branch adds, and no new tag lacks a criterion (`bdd.md`);
- TST-05 external side effects (payment, email, device) are verified at the boundary that matters.

## Security
- SEC-01 Untrusted input reaching SQL, shell, HTML, file paths, templates, deserialization, or `eval`.
- SEC-02 Authorization: the caller may access *this* resource (ownership), not just any authenticated caller.
- SEC-03 Secrets or PII committed, logged, sent to analytics, or returned in errors.
- SEC-04 Crypto: no home-made crypto, no static IV or salt, CSPRNG for tokens, constant-time secret comparison.
- SEC-05 New dependency: needed, maintained, license-compatible, pinned. Lockfile updated.

## Architecture and design
- ARC-01 Follows the repo's existing patterns and layering; the change belongs where it was put.
- ARC-02 No speculative abstraction, unused options, or "framework" for one call site (YAGNI).
- ARC-03 Public interface changes are backward compatible, or the migration is explicit.
- ARC-04 Schema or data changes: a migration exists, can be reversed or rolled forward safely, and is safe on existing data.
- ARC-05 A new feature flag has a typed definition, a safe default, an owner and, for release and experiment flags, a removal date, and both of its branches are tested (backend-services, feature flags).

## AI-typical smells
- AI-01 Placeholder code in production paths: empty stubs, `throw new Error("not implemented")`, `TODO` standing in for logic.
- AI-02 Hallucinated APIs: methods, flags, or config keys that don't exist in the pinned version.
- AI-03 Dead code introduced by the diff: commented-out blocks, unused imports or exports.
- AI-04 Output parameters instead of return values; `async` without `await`; noisy trace logging; redundant type annotations.
- AI-05 Over-defensive code: catch-all handlers that hide bugs, or checks for things the type system already guarantees.
- AI-06 Unrequested reformatting or renames that bloat the diff.

## Hygiene
- HYG-01 Changes are limited to the task. Unrelated fixes are called out separately.
- HYG-02 Commit messages follow the repo convention (Conventional Commits by default) and say what changed.
- HYG-03 Docs, AGENTS.md commands, and config examples are updated in the same change when behavior or setup changed; stale docs are Important, not Minor (see writing-documentation).
- HYG-04 User-facing text follows the product's language and i18n conventions.
- HYG-05 Web UI (accessibility, interaction states, async races, frontend performance): use the web-frontend skill's review points.
- HYG-06 Files the agent wrote (docs, plans, commits, PR text, comments, test names, logs) are in English, except verbatim quotes, docs for people the user asked for in another language, and edits inside a file already in another language, which keep that file's language (using-skills).
