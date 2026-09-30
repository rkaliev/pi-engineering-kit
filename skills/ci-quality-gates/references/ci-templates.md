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
  gate:
    if: always()
    needs: [verify, security, working-docs]
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
gate:
  stage: gate
  script: [echo "all checks passed"]
  needs: [verify, secrets, working-docs]
```

Protect the main branch and require the pipeline to succeed before merge (Settings → Merge requests), with the user's agreement.

## Code owners

`.github/CODEOWNERS` (GitHub) or `CODEOWNERS` (GitLab). The last matching line wins, so the catch-all goes first. Keep only the lines for files the project has, and use real team handles; never guess them.

```
*                     @org/maintainers
/CLAUDE.md            @org/maintainers
/AGENTS.md            @org/maintainers
/.claude/             @org/maintainers
/.pi/                 @org/maintainers
/.github/             @org/platform
/.gitlab-ci.yml       @org/platform
/docs/decisions/      @org/architects
/eslint.config.*      @org/maintainers
/tsconfig*.json       @org/maintainers
```

Then turn on "Require review from Code Owners" (GitHub branch protection) or "Code owner approval" (GitLab protected branches), with the user's agreement.

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

Compare the number of tests found with the number that ran, from the runner's report (JUnit XML, a JSON reporter or shard manifests), and fail when they differ. This catches a shard that crashed before reporting.
