# Test standard

Load this when writing, changing or reviewing tests. It is the single source of the kit's test rules: other skills link here instead of restating them. It holds on any stack; the project's own test conventions win where they are stricter.

## Expected values come from requirements

- An expected value traces to a spec, a numbered criterion or a domain rule. Quote it in the test name or a short comment when it is not obvious.
- Never derive an expected value by running the code and copying its output, and never recompute it in the test with the same algorithm the code uses. Either way the test proves only that the code does what it does.
- **The one exception is characterization tests** (pinning legacy behavior before a change, see changing-legacy-code). Name them `*.char.test.*` (or the stack's equivalent: a `characterization` tag or describe block). They pass on first run by design, and they don't count as coverage of new behavior.
- **Porting** to a new system is different: expected values taken from the old system's outputs (golden data) are acceptance tests of the new code. They fail first like any other test and are not marked as characterization.
- **Every new test is seen failing first** for the right reason, except a characterization test. "Seen failing" in a plan, a report or a PR body always means this rule.
- Give a test generator the spec and the criteria, not only the code.

## A test earns its keep

Don't write tests that cannot fail for a reason anyone cares about:
- constants, config literals, re-exports, enum or schema shapes, type declarations;
- "renders without crashing" or "is defined";
- the framework's or a dependency's own behavior;
- **mock echo**: asserting that a mock returned what you told it to return.

The same branch with different data is one parametrized test (`test.each`, table tests, `@ParameterizedTest`, `pytest.mark.parametrize`), not many copies. Text and serialized snapshots are small and inline; a large external snapshot file is not a test anyone reads. Visual baselines (images) are a separate thing, below.

## Structure and names

- Arrange, Act, Assert; one behavior per test. Several assertions are fine when they describe one outcome. Every test asserts something.
- Name = subject + circumstance + result: `applyDiscount rounds half up when the discount has a fraction of a cent`.
- Prefer readable tests over clever reuse (DAMP over DRY): a reader understands one test without opening three helpers.
- Test data is built in the test or by a small builder with explicit overrides; no shared mutable fixtures.
- Test-only helpers, flags and hooks live in test code, never in production code.

## Test doubles

- Fake only what you don't control: third-party HTTP APIs, e-mail and SMS, payment providers, devices and peripherals, the clock and randomness.
- Your own database, queues and file layout are real in integration tests (a container, an embedded or local instance), because that is where mistakes hide. A fake is allowed only at a deliberate fault-injection seam (simulating a timeout or a crash).
- Each boundary has one shared stub (the project's HTTP mock library or helper, one fake clock, one fake mailbox), not an ad-hoc override of globals in each test. Stub at the network boundary, not by replacing your own client classes.
- **Provider sandboxes** (a payment provider's or another vendor's test environment) are a separate suite with its own tag and its own CI job, with credentials from the CI secret store. They are the one place a test talks to the network, and they never run in the default suite.

## Determinism and isolation

- Time is controlled (fake timers or an injected clock). Randomness is seeded.
- No real network in the default suite: unknown hosts point at a closed port so a missed stub fails loudly.
- Run with a non-UTC timezone and a non-English locale somewhere in CI, so date and format bugs surface.
- **Waiting:** wait for a condition or an event, with one short project-wide ceiling as the upper bound. Never sleep for a fixed time.
- Tests don't depend on order and can run in parallel: each creates its own identities and data, shared seed data is read-only, cleanup is registered where the data is created and runs in reverse order, and global setup is idempotent.
- Missing test infrastructure (the database, a container, an emulator) fails the run with the command that fixes it. It is never a reason to skip.
- A test cache must not hide a test whose result depends on a database or other outside state: such tests run uncached.
- Test accounts, demo personas and fixtures never reach a production build; where the project has one, CI checks it.

## Retries

A test never retries: not in the runner config, not in CI, not by re-running the test or a block of assertions until it passes. Waiting for a condition under the ceiling (a web-first assertion, `expect.poll`, `waitFor`) is waiting, not a retry. Retrying a transient failure of an external system is product behavior (see systematic-debugging and the platform skills) and is tested like any other behavior.

## Flaky tests

A flake is fixed only when all of these hold, and the report shows them:
1. the failing run and the failing boundary are identified;
2. the root cause is explained, and the fix removes it (not a longer wait, not a weaker assertion);
3. a repeated run passes on the same commit (`--repeat-each`, `-count=N`, `--rerun-each`, or the stack's equivalent);
4. it passes in the configuration where it failed (the same shard, coverage on, the CI image);
5. the full suite passes.

Quarantining a flaky test is a skip: it follows "Changing tests" below and counts as a known gap.

## Criteria and levels

Every numbered criterion of a task is verified exactly as follows. The task file's "How it is verified" column names the test.
- **A user-visible criterion in a project with BDD scenarios:** exactly one scenario, tagged with the criterion (`bdd.md`), written first (outside-in, test-driven-development). The unit tests that drive the code underneath it test each unit's own contract (its inputs, edges and errors) and stay.
- **Any other criterion:** at least one test at the cheapest level that shows it the way a user or caller sees it: a unit test for pure logic, an API or integration test for a service, a component or integration test for a screen.
- **End-to-end tests without BDD** cover critical user flows only, one journey each. A screen's other criteria are covered at the component or integration level.
- **Layers don't repeat each other:** a unit test that asserts the user-level outcome a scenario already proves (the same journey, through the same entry point) is not written, or is removed in REFACTOR before the commit. Unit tests of a unit's own contract are not repetition, even on the happy path.
- **A manual check** replaces a test only where automation is impossible (real hardware, a store review, a fiscal device, a physical signature). The task file names the manual step and the reason, the user agrees to it, and the report says it ran. Anywhere else a criterion without a test is a gap. A manual run on top of the tests (the target browsers, a device, the changed flow) is extra evidence, not a replacement.
- One scenario or end-to-end test = one journey. It sets up its preconditions through the fastest path (an API call or a seeded state, not the UI) and is independent of the others. Prefer accessible roles and labels, or stable test IDs, over CSS or XPath selectors.

## Coverage

- Coverage is a floor that finds untested code, not a target. It is measured on a schedule and never blocks a merge.
- Don't write tests to move the number, and never open a change whose only purpose is coverage: a test without a requirement behind it doesn't count.

## Visual regression

Baselines are produced only in CI, on the image that checks them (in Git LFS where the project uses it). Accepting a changed baseline is a deliberate run that the user asks for. The global diff threshold is never raised to make a diff pass.

## Changing tests

- **Allowed with the reason in the commit:** deleting a test together with the behavior it protected (the feature is removed), and deleting a test that never protected anything (it breaks "A test earns its keep").
- **Everything else needs the user's agreement and its own commit:** editing an assertion, deleting a test whose behavior still exists, adding a skip or quarantine. A skip names a linked issue (`#123`, a URL or `ABC-123`) on its line or the line above; a reason in words alone ("flaky", "needs docker") is not enough. Never in the same commit as the code change it would hide.
- **`test-hygiene: allow <reason>`** marks a line where a checked pattern is the behavior under test (a test of the retry logic itself, a sleep that is the subject). It is not a way around these rules: an allow that hides a skip, a retry or a sleep that this standard forbids needs the user's agreement like the change it hides.

## Make it mechanical

With the user's agreement, ci-quality-gates adds two layers that check these rules on every change, on any stack:
- the kit's `test-hygiene` script (focused tests, skips without a linked issue, sleeps, retries in runner configs and test code, the number of tests that ran, criterion tags on the tag lines a branch adds or changes), which checks only added lines in an existing project, so old debt doesn't block;
- the stack's own linters where it has them (for example `no-focused-tests`, `expect-expect`, no conditional assertions, small snapshots, `go test -race`, randomized order).
