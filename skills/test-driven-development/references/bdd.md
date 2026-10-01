# BDD scenarios (optional acceptance layer)

Use BDD when acceptance criteria should read in the domain's language and be checked end to end: web and API products, payment, checkout and POS flows, anything people outside the team review. Skip it for libraries, CLIs and pure logic, where unit and API tests say the same thing more cheaply. Adding it to a project is the user's decision.

**Tools:**
- web: playwright-bdd or Cucumber-JS;
- JVM: Cucumber-JVM or Karate (APIs);
- Python: pytest-bdd or Behave;
- Go: Godog;
- .NET: Reqnroll.

## Link to the criteria

Every user-visible criterion in the task file's success criteria table maps to exactly one scenario, tagged with the criterion (`@C3`). The "How it is verified" column names the scenario. Criterion → scenario → CI stays traceable, and review checks it against the task file: a criterion without a scenario, two scenarios for one criterion, or a new tag with no criterion is a finding. Tags of finished tasks stay as history. Criteria the user doesn't see are verified by tests at a lower level (`test-standard.md`, "Criteria and levels").

**Order: outside-in.** The scenario is written and run before the code it needs, and it must fail on the step that needs the missing behavior. Unit-level TDD cycles then drive the code until the scenario passes (test-driven-development, "With BDD scenarios").

## Writing scenarios

- **One scenario is one user journey** with an outcome the user cares about. Never write one just to check that a page or element exists.
- Use Examples tables or several personas only when the outcome differs between rows.
- **Given sets up through the fastest path:** an API call, a seed or a stored session, never by clicking through the UI. Prove each step through the UI once, in its own scenario.
- Steps use domain language ("the cashier closes the shift"), not UI mechanics ("clicks #btn-3"). Step definitions are thin and call shared helpers.
- **Selectors:** accessible roles and labels, or stable test IDs. Never CSS paths or text that changes with translation.
- **Waiting:** for a state or an event, under the project-wide ceiling (for example 1 s by default and 2 s at most against a local server). A step that needs longer is a performance defect to fix or report, not a ceiling to raise.
- Tags carry the criterion and the priority. A serial-only scenario needs a written reason.
- Visual checks go through one shared snapshot step.

Isolation, retries, flakes, skips and visual baselines follow `test-standard.md`, the same as every other test.
