---
name: onboarding-existing-codebase
description: Use when starting work in an unfamiliar or legacy repository, when AGENTS.md is missing or stale, or when asked to map a codebase or set it up for agent work
---

# Onboarding an existing codebase

Learn the repo from its evidence (manifests, CI, scripts, tests), not from guesses. Then write down what you learned, so every later session starts oriented. **Read-only until the map is done.**

## 1. Map

- **Stack and runtime:** `package.json`, lockfiles, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`/`global.json`, `build.gradle(.kts)`/`libs.versions.toml`, `Podfile`/`Package.swift`, `.nvmrc`, `.tool-versions`, Dockerfiles.
- **Real commands:** the CI config (`.github/workflows`, `.gitlab-ci.yml`, Jenkinsfile), `Makefile`/`justfile`, package scripts, the Gradle wrapper, Xcode schemes. **CI is the truth**; the README may be stale.
- **Structure:** entry points, modules and layers, and where business logic lives. Note generated code, vendored code, migrations and anything else that must not be hand-edited.
- **Conventions:** formatter and linter configs, commit style (`git log --oneline -30`), branch naming, test layout and naming, error-handling and logging patterns.
- **Existing agent files:** AGENTS.md, CLAUDE.md, `.cursor/rules`, `.github/copilot-instructions.md`. Reuse them; don't duplicate them.
- **Risky areas:** payments, auth, data migrations, fiscal or device integrations, anything without tests.

On a large repo, dispatch `scout` agents per area in parallel (dispatching-parallel-agents), then merge their findings.

## 2. Prove the commands

Run install, build, test and typecheck/lint exactly as CI does. Record which ones pass, fail (with the reason) or can't run here (missing credentials or devices). **Don't fix anything yet.** Report the baseline.

## 3. Write the manifest

Create or update `AGENTS.md` from `../../templates/AGENTS.md`:
- stack and versions, as pointers to their source files;
- the proven commands;
- the rules that differ from defaults;
- the boundaries (don't touch, ask first);
- the Definition of Done.

Keep it under about 150 lines. Link to docs instead of copying them. In a monorepo, a short nested `AGENTS.md` per package overrides the root one for that package.

Create `.pi/verify.json` with the fast, reliable checks:

```json
{ "commands": ["npm run typecheck", "npm test"], "timeoutSec": 600 }
```

If something is unclear (ownership, "is this dead code?", what not to touch), **ask the user**. Don't encode guesses as rules.

## 4. Hand off

Summarize the stack, how to run it, the baseline results, the risky areas, and open questions. New changes then follow changing-legacy-code.
