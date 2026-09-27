---
name: choosing-a-stack
description: Use when starting a new project, service or app, or when choosing a language, framework, database, library or platform for new work
---

# Choosing a stack

Pick for **reliability in this domain**, not novelty. The best stack is the one that will still be supported, hireable and secure in five years, and that fits the platform and compliance constraints. **A stack choice is a fork: present options and ask the user.**

In an existing codebase the stack is already chosen. Use what is there (changing-legacy-code) unless the user explicitly asks for a migration.

## Process

1. **Collect constraints:**
   - target platforms and OS floors;
   - domain (payments, POS or regulated work raises the bar);
   - team skills and existing company stacks;
   - hosting and deployment target;
   - offline needs, latency and scale;
   - licensing and compliance (PCI DSS, personal-data law, fiscal law);
   - integration SDKs that exist only for some platforms. Payment terminals, fiscal devices and vendor SDKs often decide it.
2. **Score 2–3 candidates** against these criteria:
   - maturity and a supported LTS line;
   - breadth of the ecosystem for the needed integrations;
   - type safety;
   - testability;
   - security track record;
   - team fit;
   - operational cost;
   - lock-in.
3. **Verify facts at the source.** Check the current LTS or stable versions, support windows and SDK requirements in the official docs or release pages. Never state them from memory.
4. **Recommend one**, with its trade-offs and what would change the decision. Record the decision (an ADR, see writing-documentation, or the spec) with the date and pinned versions.
5. **Scaffold with the official tool** for the chosen stack, and set up CI from the start (ci-quality-gates). For web and API products, offer BDD as the acceptance layer; the user decides. Pin exact versions, commit the lockfile, and add formatter, linter, typecheck and test commands from the start. Write them into AGENTS.md (`../../templates/AGENTS.md`) and `.pi/verify.json`.

## Reliable defaults (starting points, not rules)

| Area | Default | Consider instead when |
|---|---|---|
| Web frontend (then web-frontend) | TypeScript (strict) + React with a mainstream meta-framework, or the company standard | SEO- or content-heavy (SSR/SSG first), very small widget (vanilla or a small library) |
| Backend / API | TypeScript on Node LTS, Kotlin/Java (Spring) or .NET LTS, Go for small infra services | Heavy transactional or financial domain: prefer JVM or .NET with strong typing and mature DB tooling. Runtime rules: backend-services |
| Database | PostgreSQL | Embedded, local or offline: SQLite. Analytics: a columnar store alongside, not instead |
| Android | Kotlin + Jetpack Compose, Gradle version catalog | Payment or POS terminals: vendor SDK constraints (often Android with a fixed API level) |
| iOS | Swift + SwiftUI (UIKit where needed), SPM | — |
| Cross-platform mobile | Flutter or React Native when one team ships shared UI | Deep platform or hardware integration: native |
| Windows desktop | .NET LTS + WinUI 3 / WPF | Cross-platform: Tauri (Rust + web UI) or Electron |
| Linux services / CLI | Go or Rust for single binaries, Python for scripting and data | — |
| Games / entertainment | Unity or Unreal, Godot for smaller 2D/3D | Web games: TypeScript + a WebGL/Canvas engine |

**Money and regulated domains:**
- use a decimal or integer-minor-units money type;
- choose a certified gateway or provider SDK over home-grown protocol code;
- use managed secrets (KMS or Vault), not config files.
See payments-and-money and pos-systems.

## Red flags

- Choosing by hype or benchmarks with no domain need.
- A dependency with one maintainer for a core concern.
- Versions you haven't checked are still supported.
- Adding a second language or framework to a repo "because it's nicer".
