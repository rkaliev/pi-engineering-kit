# Review checklist

Load the fixed severities always, and only the other sections that match the diff.

## Fixed severities

These don't move with the author's arguments or with how common the pattern is in the repo.

| Finding | Severity |
|---|---|
| Secret, key or credential in code, config, logs, tests, a build argument, an image or a client bundle | Critical |
| Injection, missing authorization or authentication check, unsafe deserialization | Critical |
| Money or data loss: float money, lost update, missing idempotency or transaction on a write path | Critical |
| A test weakened, deleted or skipped to get green, or changed in a way test-standard's "Changing tests" doesn't allow | Critical |
| A focused test (`.only`, `fit`, `@only`) committed | Critical |
| A CI check removed, skipped, set to continue on error, or given retries; retries in a test runner or end-to-end config | Critical |
| Placeholder code in shipped paths: `TODO: implement`, stub returns, `throw new Error("not implemented")`, commented-out logic | Critical |
| Suppressed type or lint errors without a written reason: `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `@Suppress`, `# type: ignore`, `//nolint`, `@SuppressLint` | Critical |
| Personal or payment data in logs at info or above, even masked | Critical |
| Destructive schema change without expand/contract or a recovery path; an applied migration edited | Critical |
| A numbered criterion without a test, or with a manual check where automation is possible or the user didn't agree to it | Important |
| A plan's Review focus line without a test | Important |
| A test without an assertion or one asserting mock echo; an expected value copied from the code's output or recomputed with its algorithm (outside a marked characterization test) | Important |
| A test-only helper, flag or hook in production code | Important |
| A fixed sleep in a test; a real network call outside the provider-sandbox suite | Important |
| A `test-hygiene: allow` that hides a forbidden skip, retry or sleep without the user's agreement | Same as the pattern it hides |
| Payments without a test against the provider sandbox; POS without a list of what ran on real hardware | Important |
| An outbound call, queue or database wait without a deadline | Important |
| Environment read outside the config module, or configuration not validated at startup | Important |
| A service or worker that exits without draining in-flight work on SIGTERM | Important |
| A verification command that runs locally but not in CI | Important |
| A metric label from an unbounded set (ids, URLs, messages); dynamic log messages instead of fields | Important |
| Docs the change made stale | Important |
| A project rule broken (agent manifest, path rule, decision record) | Important |
| A payment, or its status, shown optimistically before the server confirms | Critical |
| A failed optimistic update rolled back silently | Important |
| Motion on a frequent or keyboard action, ease-in on UI, scaling from 0, animated layout properties, or no reduced-motion handling (ui-motion) | Important |
| Breaking change (API, schema, config, CLI) not called out in the PR and changelog | Important |
| New function over ~100 lines or new file over ~1000 lines | Important |
| Naming, readability, small duplication | Minor |

## Correctness
- Wrong variable (shadowed, copy-pasted, from an outer scope); off-by-one errors; inverted conditions.
- Null or undefined, empty collections, empty strings, whitespace, case sensitivity, unicode, time zones and DST.
- Shared mutable state under concurrency: races, missing locks or transactions, non-atomic read-modify-write.
- Serialization drift between producer and consumer: missing fields, enum mismatch, `undefined` vs `null`, number precision.
- Error paths: swallowed exceptions, partial writes without rollback, retries without idempotency.
- Resource leaks: unclosed handles, listeners or timers, unbounded caches or queues.
- Performance: I/O or queries in a loop (N+1), quadratic scans where a Map or Set would do, unbounded result sets without pagination.

## Tests
Check the diff against `../../test-driven-development/references/test-standard.md`, the single source of the test rules; the fixed severities above rate what it finds. In particular:
- each criterion is verified as "Criteria and levels" says, and its new tests were seen failing first as the standard defines it (the PR or report says how);
- layers don't repeat each other: a unit test restating a scenario's happy path is a finding;
- determinism and isolation: controlled clock and randomness, own data per test, cleanup registered where data is created, no shared mutable state;
- external side effects (payment, email, device) are verified at the boundary that matters.

## Security
- Untrusted input reaching SQL, shell, HTML, file paths, templates, deserialization, or `eval`.
- Authorization: the caller may access *this* resource (ownership), not just any authenticated caller.
- Secrets or PII committed, logged, sent to analytics, or returned in errors.
- Crypto: no home-made crypto, no static IV or salt, CSPRNG for tokens, constant-time secret comparison.
- New dependency: needed, maintained, license-compatible, pinned. Lockfile updated.

## Architecture and design
- Follows the repo's existing patterns and layering; the change belongs where it was put.
- No speculative abstraction, unused options, or "framework" for one call site (YAGNI).
- Public interface changes are backward compatible, or the migration is explicit.
- Schema or data changes: a migration exists, can be reversed or rolled forward safely, and is safe on existing data.

## AI-typical smells
- Placeholder code in production paths: empty stubs, `throw new Error("not implemented")`, `TODO` standing in for logic.
- Hallucinated APIs: methods, flags, or config keys that don't exist in the pinned version.
- Dead code introduced by the diff: commented-out blocks, unused imports or exports.
- Output parameters instead of return values; `async` without `await`; noisy trace logging; redundant type annotations.
- Over-defensive code: catch-all handlers that hide bugs, or checks for things the type system already guarantees.
- Unrequested reformatting or renames that bloat the diff.

## Hygiene
- Changes are limited to the task. Unrelated fixes are called out separately.
- Commit messages follow the repo convention (Conventional Commits by default) and say what changed.
- Docs, AGENTS.md commands, and config examples are updated in the same change when behavior or setup changed; stale docs are Important, not Minor (see writing-documentation).
- User-facing text follows the product's language and i18n conventions.
- Web UI (accessibility, interaction states, async races, frontend performance): use the web-frontend skill's review points.
