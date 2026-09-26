# <Project name>

<One or two sentences: what this is, who uses it, the domain (e.g. POS for cafés, payments API, casual game).>

## Stack
- <Language / framework / runtime>. Versions come from <.nvmrc | global.json | libs.versions.toml | …>; don't restate them here.
- <Database, queues, key integrations (payment provider, fiscal device SDK, …)>

## Structure
- `<path>/` — <responsibility>
- `<path>/` — <responsibility>
- Generated or vendored, do not edit by hand: `<path>`

## Commands
Run exactly these; they mirror CI.
- `<install command>`: install with the lockfile
- `<test command>`: tests
- `<typecheck/lint command>`: static checks
- `<build command>`: build
- `<dev command>`: dev server. <Run it | Don't run it; it's already open in another terminal>

## Rules
<Only what differs from sensible defaults or from the pi-engineering-kit skills. Delete lines that don't apply.>
- Business logic lives in `<path>`; UI and components only display state.
- New dependencies need approval.
- Money: <integer minor units | Decimal>; see the payments-and-money skill.
- UI text language: <ru | en | …>. Test names: <language>.
- Commits: <Conventional Commits | house style>. <Any trailer or issue-ID rules.>

## Boundaries
- Ask first: <migrations, public API changes, payment/fiscal flows, release config, …>
- Never: <touch `<path>`, run against production, read `.env`, …>

## Definition of done
1. Each criterion of the task is covered by a test, or checked manually. Say which, and how.
2. `<test command>` and `<typecheck command>` ran in this session and passed.
3. The final message lists changed files, commands run with their results, and what was not verified.

Don't say "done" if the commands weren't run.
