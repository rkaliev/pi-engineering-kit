# TypeScript full-stack profile

One candidate for a new web product, not a rule. Present it beside the other candidates and let the user decide. Check every version at the source (nodejs.org, the registry, release pages); this file names none.

## When it fits

- A new web product or SaaS, one team, full-stack TypeScript, PostgreSQL, a server-rendered or SPA web client plus an API.

Don't take it for:
- a financial core or heavy ledger (the kit default stays JVM or .NET);
- POS hardware and vendor SDKs, native mobile, small infra services (Go);
- teams split by language;
- a company standard that says otherwise.

## Selection filter

- No beta or pre-release packages and no 0.x packages in key roles.
- No vendor SaaS by default. Error tracking and the like are a separate decision.
- One tool per role.

## Roles

| Role | Choice | Why | Not when | Alternative |
|---|---|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Cached typecheck, lint, test, build; affected-only runs | One app only: a single package | Nx |
| Runtime | Node active LTS, exact; `.nvmrc` is the single source, `engines` and CI derive from it | One version everywhere | — | none (Bun and Deno are not a reliability-first default) |
| Language | TypeScript strict + `noUncheckedIndexedAccess`; presets in a shared `typescript-config` package | Same rules in every package | — | — |
| Web | React + Vite, TanStack Router + TanStack Query; no global client store (server state lives in the query cache) | Typed routes, one cache | SEO or content-heavy: SSR (TanStack Start or another meta-framework) | Next.js, React Router framework mode |
| API | Express 5; `/healthz` liveness, `/readyz` readiness, SIGTERM drain (backend-services) | Mature, widest middleware | Smaller, Web-standard runtime wanted | Hono, Fastify |
| Contracts | Zod schemas on the server as the single source; tRPC for the own web client; versioned REST `/api/<name>/v1` with OpenAPI generated from the same schemas for integrators | One schema, two consumers | No external integrators: skip REST | — |
| Config | One typed module, validated once at startup, fails fast, no defaults for secrets; packages never read env (backend-services) | Bad config stops the boot | — | — |
| Data | PostgreSQL as the only store: queue (`FOR UPDATE SKIP LOCKED`), cache, rate limits, locks (backend-services). Prisma for schema and migrations only; Kysely for every query, types generated from the schema | Fewer moving parts; typed SQL | A measurement shows Postgres can't carry it | Drizzle (schema and queries in one tool) |
| Migrations | Transactional, expand/contract, `statement_timeout` and `lock_timeout` per pooled connection (database-changes) | No long locks | — | — |
| Money | Integer minor units in 64-bit columns, with currency and ISO 4217 exponent (payments-and-money) | No float, no overflow | — | — |
| Tests | Vitest co-located; HTTP stubbed at `fetch`; Playwright end-to-end; BDD with Gherkin (playwright-bdd) when the user chooses it (test-driven-development) | Fast loop, real browser check | — | — |
| Quality | ESLint flat config in a shared package, plus custom rules that encode standards; Prettier; commit hooks for fast checks only | Standards enforced, not remembered | — | — |
| Observability | Structured JSON logger with a fixed field schema and redaction, OpenTelemetry traces, Prometheus-style metrics (observability) | Vendor-neutral | — | — |
| Dependencies | Exact pins (`saveExact`), committed lockfile, Renovate in a time window, a release-age delay for new versions, every override or patch with a reason and a removal condition (updating-dependencies) | Reproducible, small attack window | — | — |
| CI | One gate; affected-only with fallback to everything; cache written only from main (ci-quality-gates) | Fast and honest | — | — |

Notes:
- Types for Kysely come from `prisma-kysely`; the alternative is `kysely-codegen` from the live DB. Either generator has a single-maintainer risk: record it in the decision.
- Custom lint rule ideas: no raw SQL strings, timing-safe secret comparison, signal handlers required, thin route files.
- Server-only validation libraries stay out of the client bundle, and a lint rule or bundle check enforces it (web-frontend).
- Use one module dialect for the whole repo. A mix of bundler and NodeNext resolution is a known weakness.

## Warnings

Each one went wrong in a production monorepo of this shape.

- Agent rules synced from outside contradicted the binding stack standard: keep one source of truth for stack rules, in the repo.
- Version drift (three TypeScript versions, two Zod majors, two tsconfig dialects, two Postgres majors): one version per tool repo-wide, checked in CI.
- Beta packages and a preview compiler as the production typecheck, many patches and overrides without an exit, `@latest` in tool configs: apply the filter, give every patch an exit.
- Thousands of transitive packages and tiny zero-version helpers for trivial jobs: write the ten lines, or take a mature package.
- Heavy local setup (a dozen-plus compose services, mandatory extra tooling) and CI where setup took ten times longer than the checks: keep local infra to PostgreSQL, measure CI setup.
- Lock-in to one cloud and one model vendor without the planned abstraction: build the abstraction first or accept the lock-in in writing.
- Money in 4-byte `Int` `*Cents` columns: a ceiling of about twenty-one million major units and a two-decimal assumption. Use the Money row.
- A coverage floor checked only weekly, never blocking PRs: if you set a floor, gate on it; otherwise drop it.

## Scaffold steps

1. Check the current Node LTS at nodejs.org and that `node` runs it; run `corepack use pnpm@latest`.
2. Run `node "<kit root>/scripts/scaffold-template.ts" <dir>`. It copies `templates/ts-monorepo/`, writes `.nvmrc` and `packageManager`, and installs the packages listed in `scaffold.json` with `pnpm add -E`.
3. Pin each `@<sha>` in the workflow to the action's latest release commit.
4. Run `pnpm turbo run typecheck lint test`.
5. Write a decision record with the installed versions (writing-documentation).
