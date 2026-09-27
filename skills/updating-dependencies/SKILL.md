---
name: updating-dependencies
description: Use when updating, adding or removing a dependency, handling dependency or security update PRs, or when a lockfile, SDK, runtime or toolchain version must change
---

# Updating dependencies

A dependency change is a code change you didn't write. Treat it with the same care: one at a time, with its changes read, and proven by the checks.

## Rules

- **One dependency per change,** or one group that must move together (a framework and its plugins). Never batch unrelated updates: a failure must point at one cause.
- **Ask first** for a major version, a new dependency, a removed one, or a new licence type. Name what it costs: the breaking changes, the size, the maintenance status, and the licence.
- **Security first.** Start with known advisories (`npm audit`, `pnpm audit`, `osv-scanner`, `pip-audit`, `govulncheck`, `cargo audit`, Dependabot or Renovate alerts). Fix the ones that reach your code before routine bumps.
- **The package manager edits the lockfile,** never your hands. Commit the manifest and the lockfile together.
- **Pin the way the project pins.** Follow its version catalog, ranges or exact pins; don't restate versions from memory.

## Process

1. Read the current version and what depends on it (`npm ls <pkg>`, `gradle dependencies`, `go mod why`).
2. Read the changelog or release notes for every version between the current and the target. List the breaking changes and the deprecations that touch this codebase (grep for the APIs they name).
3. Update with the package manager (`npm install <pkg>@<version>`, `./gradlew … versionCatalogUpdate`, `go get`, `cargo update -p`), then adapt the code for the listed changes.
4. Run the full verification, plus a manual run of a flow that uses the dependency. Never skip or re-run CI to get past a failure.
5. Report: the package, from → to, the breaking changes found and what you changed for each, and the checks that ran.

## Platform constraints

- **Mobile:** the target and compile SDK, the Kotlin and AGP matrix, the minimum iOS version and Xcode, and store policy limit what you can take (see mobile-development).
- **POS and payment terminals:** the vendor SDK fixes the Android API level and often its own library versions (see pos-systems). An update that the vendor hasn't certified is a question for the user, not a bump.
- **Runtimes and toolchains** (Node, JDK, .NET, Go, Xcode): change the version file the project uses (`.nvmrc`, `global.json`, `go.mod` toolchain, `.tool-versions`) and CI in the same change.

## Red flags

| Thought | Reality |
|---|---|
| "I'll bump everything at once" | Then nobody knows which one broke it. One at a time. |
| "Patch releases can't break anything" | They do. Run the checks. |
| "The changelog is long, skip it" | The breaking change you skipped is the bug you'll debug. |
| "CI flaked, re-run it" | Find out why first (systematic-debugging). |
