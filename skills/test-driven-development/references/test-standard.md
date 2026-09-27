# Test standard

Load this when writing, changing or reviewing tests. It holds on any stack; the project's own test conventions win where they are stricter.

## Expected values come from requirements

- An expected value traces to a spec, a numbered criterion or a domain rule. Quote it in the test name or a short comment when it is not obvious.
- Never derive an expected value by running the code and copying its output. That test proves only that the code does what it does.
- **The one exception is characterization tests** (pinning legacy behavior before a change). Mark them as such (`*.char.test.*`, a `characterization` tag or a describe block), and don't count them as coverage of new behavior.
- Give a test generator the spec and the criteria, not only the code.

## A test earns its keep

Don't write tests that cannot fail for a reason anyone cares about:
- constants, config literals, re-exports, enum or schema shapes, type declarations;
- "renders without crashing" or "is defined";
- the framework's or a dependency's own behavior;
- **mock echo**: asserting that a mock returned what you told it to return.

The same branch with different data is one parametrized test (`test.each`, table tests, `@ParameterizedTest`, `pytest.mark.parametrize`), not many copies. A test that no longer protects a behavior is deleted, with the reason in the commit.

## Structure and names

- Arrange, Act, Assert; one behavior per test. Several assertions are fine when they describe one outcome.
- Name = subject + circumstance + result: `applyDiscount rounds half up when the discount has a fraction of a cent`.
- Prefer readable tests over clever reuse (DAMP over DRY): a reader understands one test without opening three helpers.
- Test data is built in the test or by a small builder with explicit overrides; no shared mutable fixtures.

## Test doubles

- Fake only what you don't control: third-party HTTP APIs, e-mail and SMS, payment providers, devices and peripherals, the clock and randomness.
- Your own database, queues and file layout are real in integration tests (a container, an embedded or local instance), because that is where mistakes hide. A fake is allowed only at a deliberate fault-injection seam (simulating a timeout or a crash).
- Stub HTTP at the network boundary (the project's HTTP mock library), not by replacing your own client classes.

## Determinism

- Time is controlled (fake timers or an injected clock). Randomness is seeded.
- No real network: unknown hosts point at a closed port so a missed stub fails loudly.
- Run with a non-UTC timezone and a non-English locale somewhere in CI, so date and format bugs surface.
- Tests don't depend on order and can run in parallel. Each creates the data it needs and cleans it up.
- Never synchronize with sleep or a fixed timeout. Wait for a condition or an event.

## Flaky tests

- A retry is not a fix. End-to-end configs run with retries off, so a flake is visible.
- A flake is fixed when you can name the failing boundary and the root cause, the fix removes that cause, and a repeated run passes (`--repeat-each`, `-count=N`, `--rerun-each`, or the stack's equivalent). Put that evidence in the report.
- Quarantining a flaky test needs the user's agreement and an issue, and it counts as a known gap.

## Acceptance level

- Every numbered criterion of a task maps to at least one test that shows it the way a user or caller sees it. Use the cheapest level that can: an API test for a service, a UI or end-to-end test for a screen (Playwright, Espresso, XCUITest, or BDD scenarios where the project uses them), and a unit test when the criterion is pure logic.
- One scenario = one journey. It sets up its own preconditions through the fastest path (an API call or a seeded state, not the UI), and it is independent of the others.
- Prefer accessible roles and labels, or stable test IDs, over CSS or XPath selectors.

## Coverage

- Coverage is a floor that finds untested code, not a target. Don't write tests to move the number, and never open a change whose only purpose is coverage.
- New code has tests for each of its criteria, whatever the percentage says.

## Changing tests

Editing an assertion, deleting a test, or adding a skip is a separate commit with the reason, and it needs the user's agreement. Never do it in the same commit as the code change it would hide.

## Make it mechanical

Propose the lint rules the stack has, and add them only with the user's agreement:
- no focused or skipped tests (`no-focused-tests`, `no-disabled-tests`);
- every test asserts (`expect-expect`);
- no conditional assertions;
- small inline snapshots only;
- the race detector for Go (`go test -race`);
- randomized test order where the runner supports it;
- retries off in the end-to-end config.
