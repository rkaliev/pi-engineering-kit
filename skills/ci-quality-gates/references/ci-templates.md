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
  gate:
    if: always()
    needs: [verify, security]
    runs-on: ubuntu-latest
    steps:
      - run: test "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped') }}" = "false"
```

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
gate:
  stage: gate
  script: [echo "all checks passed"]
  needs: [verify, secrets]
```

Protect the main branch and require the pipeline to succeed before merge (Settings → Merge requests), with the user's agreement.

## Tools by stack

| Stack | Test hygiene | Dependency audit | Notes |
|---|---|---|---|
| JS/TS | eslint-plugin-vitest or eslint-plugin-jest (`no-focused-tests`, `no-disabled-tests`, `expect-expect`, `no-conditional-expect`); Playwright `forbidOnly: true`, `retries: 0` | `npm audit`, osv-scanner | `tsc --noEmit` as its own step |
| JVM / Kotlin / Android | detekt or ktlint; JUnit `@Disabled` needs a reason | OWASP dependency-check, osv-scanner | `./gradlew check`; Android: `assembleRelease`, lint, instrumented tests on an emulator |
| Swift / iOS | SwiftLint | osv-scanner (SwiftPM) | `xcodebuild test` on a simulator; signing from CI secrets |
| Go | `go vet`, staticcheck | `govulncheck` | `go test -race ./...` |
| Python | ruff (including `PT` rules) | `pip-audit` | `pytest -p no:cacheprovider`; randomized order with pytest-randomly |
| .NET | analyzers as errors | `dotnet list package --vulnerable` | `dotnet test` |

## Test-count check

Compare the number of tests found with the number that ran, from the runner's report (JUnit XML, a JSON reporter or shard manifests), and fail when they differ. This catches a shard that crashed before reporting.
