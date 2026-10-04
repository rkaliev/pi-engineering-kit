# TypeScript full-stack profile

One candidate for a new web product, not a rule. Never call it the kit's default or recommended stack. Present it beside the other candidates, recommend it only on the user's constraints, and say what would change the choice. Check every version at the source (nodejs.org, the registry, release pages); this file names none.

## When it fits

- A new web product or SaaS, one team, full-stack TypeScript, PostgreSQL, a web client plus an API. Server-side rendering is covered by the Web row's alternative.

Don't take it for:
- a financial core or heavy ledger (the kit default stays JVM or .NET);
- POS hardware and vendor SDKs, native mobile, small infra services (Go);
- teams split by language;
- a company standard that says otherwise.

## Selection filter

- No beta or pre-release packages and no 0.x packages in key roles. An exception is named, with its reason, in the decision record. Kysely is one: stable API, widely used, 0.x only by its versioning habit. Drizzle and `kysely-codegen` are also 0.x or pre-release: check at the registry and record whichever you choose.
- No vendor SaaS by default. Error tracking and the like are a separate decision.
- One tool per role.

## Roles

| Role | Choice | Why | Not when | Alternative |
|---|---|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Cached typecheck, lint, test, build; affected-only runs | One app only: a single package | Nx |
| Runtime | Node active LTS, exact. `.nvmrc` is the single source; CI reads it (`node-version-file`); if `engines` is set, a CI check keeps it equal | One version everywhere | An edge or serverless runtime is the target | none (Bun and Deno are not a reliability-first default) |
| Language | TypeScript strict + `noUncheckedIndexedAccess`; presets in a shared `typescript-config` package | Same rules in every package | A team new to TypeScript: take the defaults table first | none (the profile is TypeScript) |
| Web | React + Vite, TanStack Router + TanStack Query; no global client store (server state lives in the query cache) | Typed routes, one cache | SEO or content-heavy: use SSR | TanStack Start or another meta-framework; Next.js; React Router framework mode |
| API | Express (current major); `/healthz` liveness, `/readyz` readiness, SIGTERM drain (backend-services) | Mature, widest middleware | A smaller or edge-runtime service | Hono (small, Web-standard, also runs on edge runtimes); Fastify (schema-first validation, throughput) |
| Contracts | Zod schemas on the server as the single source; tRPC for the own web client; versioned REST `/api/<name>/v1` with OpenAPI generated from the same schemas for integrators. The client imports only router types (`import type`), exported as emitted declarations (`.d.ts`) from a package built with its own tsconfig, or through TypeScript project references, so the web typecheck reads only declarations; the boundary lint rule allows type-only imports | One schema, two consumers | No external integrators: skip REST | ts-rest or oRPC; OpenAPI-first codegen |
| Data | PostgreSQL as the only store: queue (`FOR UPDATE SKIP LOCKED`), cache, rate limits, locks (backend-services). Prisma for schema and migrations only; Kysely for every query, types generated from the schema. Every pooled connection gets `statement_timeout` and `lock_timeout` from config (database-changes) | Fewer moving parts; typed SQL | A measurement shows Postgres can't carry it | Drizzle (schema and queries in one tool) |
| Migrations | Prisma migrations, transactional, expand/contract. `SET lock_timeout` at the top of each migration (pool timeouts don't reach `prisma migrate deploy`). Prisma has no down migrations: ship a reviewed `down.sql` with every migration and a script that runs the latest one in a single transaction and marks its history row rolled back (`migrate resolve --rolled-back` accepts only failed migrations), so that `migrate deploy` can apply it again. Run it only after the code that needs the migration was rolled back; it restores the schema, not data. Migrations run as their own deploy step (database-changes) | No long locks, rollback possible | The schema is owned by another team or tool | none (database-changes rules hold with any tool) |
| Tests | Vitest co-located; integration tests against a real Postgres; one shared `fetch` stub, not per-test overrides of globals; Playwright end-to-end; BDD with Gherkin (playwright-bdd) when the user chooses it (test-driven-development) | Fast loop, real database, real browser | An existing Jest suite worth keeping | Jest |
| Quality | ESLint flat config in a shared package, plus custom rules that encode standards; Prettier; commit hooks for fast checks only | Standards enforced, not remembered | Few standards to encode: fewer plugins is simpler | Biome (one tool for lint and format) |
| Observability | Structured JSON logger with a fixed field schema and redaction, OpenTelemetry traces, Prometheus-style metrics (observability) | Vendor-neutral | The company already runs a vendor APM | Vendor APM (a separate decision) |
| Flags | OpenFeature SDK (server and web) behind a typed flag registry; the provider is chosen per project: a self-hosted one (flagd, Unleash, GrowthBook) or a SaaS (backend-services, its feature-flags reference) | Call sites don't depend on the provider | No runtime toggles or experiments: none | The provider's own SDK |
| Dependencies | Exact pins (`saveExact`), committed lockfile, Renovate in a time window, a release-age delay for new versions, every override or patch with a reason and a removal condition (updating-dependencies) | Reproducible, small attack window | The team wants only the platform's built-in bot and accepts fewer grouping and schedule options | Dependabot (with its cooldown) |

## Rules that apply on any choice

- **Config:** one typed module, validated once at startup, fails fast, no defaults for secrets; packages never read env (backend-services).
- **Money:** integer minor units in 64-bit columns, with currency and ISO 4217 exponent. Configure the `int8` parser and the generated column type as `bigint`, because node-postgres returns `int8` as a string by default (payments-and-money).
- **CI:** one gate; affected-only with fallback to everything; cache written only from main; coverage per ci-quality-gates.

## Notes

- Types for Kysely come from `prisma-kysely`; the alternative is `kysely-codegen` from the live DB. Either generator has a single-maintainer risk: record it in the decision.
- Custom lint rule ideas: no raw SQL strings, timing-safe secret comparison, signal handlers required, thin route files.
- Server-only validation libraries stay out of the client bundle, and a lint rule or bundle check enforces it (web-frontend).
- One module dialect per runtime: bundler resolution for Vite apps, NodeNext for Node packages; never two dialects for the same runtime.

## Warnings

Each one went wrong in a production monorepo of this shape.

- Agent rules synced from outside contradicted the binding stack standard: keep one source of truth for stack rules, in the repo.
- Version drift (three TypeScript versions, two Zod majors, two tsconfig dialects for the same runtime, two Postgres majors): one version per tool repo-wide, checked in CI.
- Beta packages and a preview compiler as the production typecheck, many patches and overrides without an exit, `@latest` in tool configs: apply the filter, give every patch an exit.
- Thousands of transitive packages and tiny zero-version helpers for trivial jobs: write the ten lines, or take a mature package.
- Heavy local setup (a dozen-plus compose services, mandatory extra tooling) and CI where setup took ten times longer than the checks: keep local infra to PostgreSQL, measure CI setup.
- Lock-in to one cloud and one model vendor without the planned abstraction: build the abstraction first or accept the lock-in in writing.
- Money in 4-byte `Int` `*Cents` columns: a ceiling of about twenty-one million major units and a two-decimal assumption. Use the Money rule.

## Scaffold steps

1. Check the current Node LTS at nodejs.org and that `node` runs it. Install the latest pnpm (pnpm.io/installation) and check `pnpm --version`; the script pins it as `packageManager`. Check the current supported Postgres major at postgresql.org (postgresql.org/support/versioning) and pass it as `--postgres <major>`; the script writes it to `.postgres-version`.
2. Run `node "<kit root>/scripts/scaffold-template.ts" <absolute dir> --postgres <major>`. `<kit root>` is the folder the kit package is installed in; if it has no `templates/ts-monorepo/`, use a clone of the kit. It copies `templates/ts-monorepo/`, writes `.nvmrc`, `.postgres-version` and `packageManager`, and installs the packages listed in `scaffold.json` with `pnpm add -E`.
3. Pin each `@<sha>` in the workflow to the action's latest release commit (for an annotated tag, the `^{}` line of `git ls-remote --tags`, not the tag object).
4. Run `pnpm turbo run typecheck lint test`.
5. Write a decision record with the installed versions (writing-documentation).
