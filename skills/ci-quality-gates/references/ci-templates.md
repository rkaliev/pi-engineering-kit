# CI templates

## GitHub Actions

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<sha>        # pin to a commit SHA
      - uses: actions/setup-node@<sha>
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run typecheck              # every command from verify.json, as written there
      - run: npm test
      - run: npm run build
  security:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<sha>
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@<sha>
      - uses: google/osv-scanner-action/osv-scanner-action@<sha>
        with: { scan-args: "--recursive ./" }
  working-docs:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@<sha>
      - run: |
          leaks=$(git ls-files 'docs/tasks/*.md')
          test -z "$leaks" || { echo "::error::Delete task files before merge; move what lasts into docs/: $leaks"; exit 1; }
  test-hygiene:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@<sha>
        with: { fetch-depth: 0 }             # the script compares with the merge base
      - uses: actions/setup-node@<sha>
        with: { node-version: 22 }           # Node only runs the script; the project's stack doesn't matter
      - run: node .ci/test-hygiene.mts --base origin/${{ github.base_ref || 'main' }}
  e2e:                                       # only when the project has end-to-end or BDD tests
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@<sha>
      - run: <the project's e2e command, retries off, JUnit to test-results/>   # e.g. PLAYWRIGHT_JUNIT_OUTPUT_FILE=test-results/junit.xml npx playwright test --reporter=junit
      - uses: actions/setup-node@<sha>
        if: always()
        with: { node-version: 22 }
      - run: node .ci/test-hygiene.mts --junit test-results/   # report checks only; the source scan is the test-hygiene job
        if: always()
      - uses: actions/upload-artifact@<sha>
        if: failure()
        with: { name: e2e-evidence, path: test-results/ }
  gate:
    if: always()
    needs: [verify, security, working-docs, test-hygiene, e2e]   # drop e2e if the project has no e2e job
    runs-on: ubuntu-latest
    steps:
      - run: test "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped') }}" = "false"
```

The `working-docs` job enforces the kit's rule for people and other tools too: task files never reach the base branch (`git ls-files` pathspecs also match nested folders). Point it at the project's folders if they differ (the `workDocs` list in the guard config); drop the job if the project turned the rule off with `workDocs: []`.

Branch protection: require the `gate` check and an up-to-date branch, and block force pushes, for example with `gh api -X PUT repos/<owner>/<repo>/branches/main/protection …` (only after the user agrees).

## GitLab CI

```yaml
stages: [verify, gate]
default:
  interruptible: true
verify:
  stage: verify
  image: node:22@sha256:<digest>
  cache: { key: { files: [package-lock.json] }, paths: [.npm/] }
  script:
    - npm ci --cache .npm --prefer-offline
    - npm run typecheck
    - npm test
    - npm run build
secrets:
  stage: verify
  image: zricethezav/gitleaks@sha256:<digest>
  script: [gitleaks detect --source . --redact]
working-docs:
  stage: verify
  image: alpine/git@sha256:<digest>
  script:
    - |
      leaks=$(git ls-files 'docs/tasks/*.md')
      test -z "$leaks" || { echo "Delete task files before merge; move what lasts into docs/: $leaks"; exit 1; }
test-hygiene:
  stage: verify
  image: node:22@sha256:<digest>
  variables: { GIT_DEPTH: 0 }
  script:
    - target=${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-$CI_DEFAULT_BRANCH}
    - git fetch --quiet origin "$target"          # GitLab doesn't fetch the target branch by default
    - node .ci/test-hygiene.mts --base "origin/$target"
e2e:                                         # only when the project has end-to-end or BDD tests
  stage: verify
  image: <the project's e2e image>@sha256:<digest>   # with Node ≥22.18 for the count check
  script:                                    # after_script can't fail a job, so the count check runs in script
    - status=0; <the project's e2e command, retries off, JUnit to test-results/> || status=$?
    - node .ci/test-hygiene.mts --junit test-results/
    - exit $status
  artifacts:
    when: always
    paths: [test-results/]
    reports: { junit: test-results/*.xml }
gate:
  stage: gate
  script: [echo "all checks passed"]
  needs: [verify, secrets, working-docs, test-hygiene, e2e]   # drop e2e if the project has no e2e job
```

Protect the main branch and require the pipeline to succeed before merge (Settings → Merge requests), with the user's agreement.

## Code owners

`.github/CODEOWNERS` (GitHub) or `CODEOWNERS` (GitLab). The last matching line wins, so the catch-all goes first. Keep only the lines for files the project has, and use real team handles; never guess them.

```
*                     @org/maintainers
/AGENTS.md            @org/maintainers
/.pi/                 @org/maintainers
/.github/             @org/platform
/.gitlab-ci.yml       @org/platform
/docs/decisions/      @org/architects
/eslint.config.*      @org/maintainers
/tsconfig*.json       @org/maintainers
```

Then turn on "Require review from Code Owners" (GitHub branch protection) or "Code owner approval" (GitLab protected branches), with the user's agreement.

## Test hygiene

`.ci/test-hygiene.mts` is the kit's test-hygiene script (`scripts/` in the kit root), copied by kit-init with the user's agreement. Its first lines carry its version, so kit-init reports an older copy and replaces it on request. The `.mts` name keeps it an ES module whatever the project's `package.json` says. It needs only Node ≥22.18, whatever the project's stack, and has no dependencies. In CI it needs the full history (`fetch-depth: 0`, `GIT_DEPTH: 0`) and the base branch fetched; without a merge base it stops with a message instead of guessing.

- **What it checks:** focused tests; skips without a linked issue; fixed sleeps; retries in runner configs and test code (Playwright, Cypress, Jest, Mocha, Vitest, pytest, Gradle, gotestsum, Xcode). A platform or test-mode skip passes when its reason starts with `platform:` or `mode:`.
- **`--junit <dir>`** checks only the reports: missing or empty, or a declared count that differs from the cases that ran (a crashed shard).
- **Ratchet:** by default only lines the change adds count (renames are followed), so an existing project isn't blocked by old debt; the summary shows the pre-existing count. `--all` checks every line, for a new project or a one-off clean-up.
- **Escape hatch:** an inline `test-hygiene: allow <reason>` on the line, when the pattern is the behavior under test. An allow without a reason is itself reported.
- **Project additions:** `.pi/test-hygiene.json` with extra `testFiles`, `ignore` and `patterns`.

JUnit reports by stack (each must write a file, not print to the console): Playwright `--reporter=junit` with `PLAYWRIGHT_JUNIT_OUTPUT_FILE=test-results/junit.xml`, Vitest `--reporter=junit --outputFile.junit=test-results/junit.xml`, Jest `jest-junit` with `JEST_JUNIT_OUTPUT_DIR=test-results`, pytest `--junitxml=test-results/junit.xml`, Gradle `build/test-results/`, Go `gotestsum --junitfile test-results/junit.xml`, Xcode `xcresult` → `xcbeautify --report junit`, .NET `--logger "junit;LogFilePath=test-results/junit.xml"`.

## Tools by stack

| Stack | Test hygiene | Dependency audit | Notes |
|---|---|---|---|
| JS/TS | eslint-plugin-vitest or eslint-plugin-jest (`no-focused-tests`, `no-disabled-tests`, `expect-expect`, `no-conditional-expect`); Playwright `forbidOnly: true`, `retries: 0` | `npm audit`, osv-scanner | `tsc --noEmit` as its own step |
| JVM / Kotlin / Android | detekt or ktlint; JUnit `@Disabled` needs a reason | OWASP dependency-check, osv-scanner | `./gradlew check`; Android: `assembleRelease`, lint, instrumented tests on an emulator |
| Swift / iOS | SwiftLint | osv-scanner (SwiftPM) | `xcodebuild test` on a simulator; signing from CI secrets |
| Go | `go vet`, staticcheck | `govulncheck` | `go test -race ./...` |
| Python | ruff (including `PT` rules) | `pip-audit` | `pytest -p no:cacheprovider`; randomized order with pytest-randomly |
| .NET | analyzers as errors | `dotnet list package --vulnerable` | `dotnet test` |

## Bundle and size budgets

Measure the built, compressed artifact itself (for example the `.br` or `.gz` files, or the APK/IPA size), not the bundler's own summary, and fail when the measurement is empty. Keep the budget in a committed file; raising it is a reviewed diff that states the measurement and the reason. Report deltas on every PR, but ignore noise: flag a change only when it is both at least 1 KiB and at least 5 %.

## Test-count check

`test-hygiene --junit <dir>` compares the declared test count with the cases that ran and fails on an empty report. With shards, also check that their manifests are disjoint and together cover every test found, so a crashed shard can't pass silently.
