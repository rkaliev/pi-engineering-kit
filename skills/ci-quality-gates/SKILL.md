---
name: ci-quality-gates
description: Use when setting up or changing a project's CI pipeline, adding required checks or branch protection, or when a check that runs locally is missing from CI
---

# CI quality gates

The agent's session is one line of defence; CI is the other. CI runs on every change, whoever made it, and doesn't depend on a hook being enabled or a model being careful. So it runs **at least everything the local verification runs** (`verify.json` or the Commands section of the agent manifest), plus what can only be checked there.

## Shape

- **One required aggregating job** (`gate`) that depends on every check, and branch protection requires only that job. Adding a check then never needs a settings change.
- Checks are never disabled, skipped, marked `continue-on-error`/`allow_failure`, or given retries in order to merge. A red check is fixed at its cause (systematic-debugging).
- Actions and images are pinned (a commit SHA or a digest, not a moving tag; for an annotated tag, the peeled `^{}` commit). A smoke job outside the gate whose purpose is to track the newest release may track moving tool and image versions; its actions stay pinned by SHA. Dependencies are cached by the lockfile hash. Long suites run in parallel shards.
- In a monorepo, PRs run only the affected packages and main runs everything (`references/ci-templates.md`, Monorepo); that counts as running the verification commands.
- Each job has a timeout. Failures upload their evidence: test reports, traces, screenshots and logs.

## Layers

Propose the layers that fit the stack, explain what each catches, and add each only with the user's yes. Templates and tool choices per stack are in `references/ci-templates.md`.

1. **Verification commands:** tests, typecheck, lint and build, exactly as locally. Always.
2. **Test hygiene**, on any stack (the rules are `../test-driven-development/references/test-standard.md`):
   - the kit's `test-hygiene` script, copied into the project by kit-init with the user's agreement: focused tests, skips without a linked issue, sleeps, retries in runner configs and test code, the number of tests that ran (from JUnit XML). In an existing project it checks only lines the change adds, so old debt doesn't block; the report shows how much there is;
   - the stack's own linters where it has them (table in `references/ci-templates.md`).
3. **End-to-end:**
   - retries off;
   - artifacts on failure;
   - a JUnit report checked by `test-hygiene --junit`, so a crashed shard or an empty run can't pass silently.
4. **Security:** secret scanning (gitleaks) and a dependency audit (osv-scanner or the ecosystem's tool) on every change.
5. **Database** (database-changes): migrations applied, and rolled back where the project supports it, on a throwaway database, plus a schema drift check.
6. **Contracts:** regenerate OpenAPI, protobuf or generated types from the source of truth, and fail if they differ from what is committed.
7. **Docs:** link check, when the project keeps docs, and the `working-docs` job, so task files never reach the base branch from any author.
8. **Commits:** the project's commit linter, if it uses one.
9. **Coverage:** a report on every change, and a floor checked on a schedule. It never blocks a merge: it is a floor, not a target.
10. **Provider sandboxes**, when the project has them: a separate job for the sandbox-tagged suite, with credentials from the CI store.
11. **BDD scenarios**, when the project has them (`../test-driven-development/references/bdd.md`).

Mobile and desktop add their own jobs: a release build, signing with secrets from the CI store, and UI tests on an emulator or simulator for critical flows (see mobile-development and desktop-development).

## Branch protection

Requiring `gate`, requiring an up-to-date branch and blocking direct pushes to the main branch are repository settings: outward-facing. Write the exact instruction or command (`gh api …`, GitLab protected branches) and run it only after the user's yes.

For a team repository, offer two more, also only on the user's yes:

- **One required human approval.** An AI review (the kit's reviewer, a review bot) supplements it and never replaces it.
- **Code owners** (`CODEOWNERS` on GitHub and GitLab) for the files that steer every other change: the agent manifest and the agent's config folder, path rules, `.github/` or the CI config, `docs/decisions/`, and the lint and type configs. With "require review from code owners" on, a change to the rules needs its owner's approval. Template in `references/ci-templates.md`.

## Keeping it in sync

- When a verification command is added or changed, change the CI in the same commit.
- The kit-init check reports CI that doesn't run every verification command or lacks the working-docs job; fix the CI rather than dropping the check locally.
- A change to the CI itself is reviewed like code: it may not remove a check or weaken one (review checklist).
- A review comment made for the third time is a rule that isn't written down yet: propose a lint rule or a check for it.
