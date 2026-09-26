# Review checklist

Load only the sections that match the diff.

## Correctness
- Wrong variable (shadowed, copy-pasted, from an outer scope); off-by-one errors; inverted conditions.
- Null or undefined, empty collections, empty strings, whitespace, case sensitivity, unicode, time zones and DST.
- Shared mutable state under concurrency: races, missing locks or transactions, non-atomic read-modify-write.
- Serialization drift between producer and consumer: missing fields, enum mismatch, `undefined` vs `null`, number precision.
- Error paths: swallowed exceptions, partial writes without rollback, retries without idempotency.
- Resource leaks: unclosed handles, listeners or timers, unbounded caches or queues.
- Performance: I/O or queries in a loop (N+1), quadratic scans where a Map or Set would do, unbounded result sets without pagination.

## Tests
- Each criterion has a test that fails without the change (someone saw it red).
- Assertions check observable behavior, not mock call counts or private internals.
- Existing tests were not weakened, skipped, or rewritten to match new output without justification.
- Determinism: no real clock, randomness, network, or order dependence without control. No sleeps where a condition wait belongs.
- External side effects (payment, email, device) are verified at the boundary that matters.

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
- Docs, AGENTS.md commands, and config examples are updated when behavior or setup changed.
- User-facing text follows the product's language and i18n conventions.
- Web UI (accessibility, interaction states, async races, frontend performance): use the web-frontend skill's review points.
