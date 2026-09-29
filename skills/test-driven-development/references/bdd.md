# BDD scenarios (optional acceptance layer)

Use BDD when acceptance criteria should read in the domain's language and be checked end to end: web and API products, payment, checkout and POS flows, anything people outside the team review. Skip it for libraries, CLIs and pure logic, where unit and API tests say the same thing more cheaply. Adding it to a project is the user's decision.

**Tools:**
- web: playwright-bdd or Cucumber-JS;
- JVM: Cucumber-JVM or Karate (APIs);
- Python: pytest-bdd or Behave;
- Go: Godog;
- .NET: Reqnroll.

## Link to the spec

Every user-visible criterion in the spec's success criteria table maps to one scenario, tagged with the criterion (`@C3`). The "How it is verified" column names the scenario. Criterion → scenario → CI stays traceable, and a criterion without a scenario is visible in review.

## Writing scenarios

- **One scenario is one user journey** with an outcome the user cares about. Never write one just to check that a page or element exists.
- Use Examples tables or several personas only when the outcome differs between rows.
- **Given sets up through the fastest path:** an API call, a seed or a stored session, never by clicking through the UI. Prove each step through the UI once, in its own scenario.
- Steps use domain language ("the cashier closes the shift"), not UI mechanics ("clicks #btn-3"). Step definitions are thin and call shared helpers.
- **Selectors:** accessible roles and labels, or stable test IDs. Never CSS paths or text that changes with translation.
- **No time-based waits.** Wait for a state or an event, with one short project-wide ceiling (for example 1 s by default and 2 s at most against a local server). A step that needs longer is a performance defect to fix or report, not a timeout to raise.
- **Scenarios are independent:** any order, in parallel, on any shard. Each creates its own data and registers its cleanup where it creates it.
- Tags carry the criterion and the priority. `@skip` needs a linked issue. A serial-only scenario needs a written reason.
- **Visual checks** go through one shared snapshot step. Baselines are produced in CI on its fixed environment, never on a laptop, and updating them is a deliberate, reviewed change.
- Retries are off. A flaky scenario is fixed at its cause (see `test-standard.md`).
