# App

<One or two sentences: what this is, who uses it.>

## Stack
- TypeScript, pnpm workspaces, Turborepo. Versions come from `.nvmrc`, `packageManager` in `package.json` and `pnpm-lock.yaml`; don't restate them here.
- PostgreSQL is the only store. Prisma owns the schema and migrations, Kysely runs every query.
- `apps/api` has no build: Node runs the `.ts` files directly (type stripping), so use `import type`, no enums, no parameter properties.

## Structure
- `apps/web/` — React + Vite. `src/client/` is browser code, `src/domain/` is pure logic.
- `apps/api/` — Express API. `src/config.ts` is the only reader of env.
- `packages/db/` — Prisma schema and migrations, Kysely client. `src/generated/` is generated, do not edit.
- `packages/typescript-config`, `eslint-config`, `prettier-config` — shared presets.

## Commands
Run exactly these; they mirror CI.
- `pnpm install --frozen-lockfile`: install with the lockfile
- `pnpm turbo run typecheck lint test`: static checks and tests

## Other tasks
Not run by the verify hooks.
- `pnpm turbo run build`: build (CI runs it)
- `pnpm format`: Prettier
- `docker compose up -d postgres`: local database (needs `POSTGRES_MAJOR` in `.env`)
- `pnpm --filter @repo/db exec prisma migrate deploy`: apply migrations. Prisma and `pnpm --filter @repo/api dev` read `.env`; `start` and CI read the process env only
- `pnpm --filter @repo/web dev`: dev server. Don't run it; it's already open in another terminal

## Rules
- Layers: client (`apps/web/src/client`), server (`apps/api`), domain (`apps/web/src/domain`, pure). Client and domain never import server code, `@repo/db` or Node modules (bare or `node:`, also through `import()`); lint enforces it, and the `build` bundle check is a backstop for `@repo/db` modules. Type-only imports of router types are allowed. Computed specifiers and `module.require` are not caught by lint; the bundle check catches them only for `@repo/db` modules. A browser polyfill named like a Node builtin is a reviewed exception added to the rule.
- Package source code never reads `process.env` (tooling config files may); only `apps/api/src/config.ts` does, and it owns every default.
- Validate input before it reaches the driver; 4xx logs carry status and type only.
- `/readyz` is 503 until the database has every migration this build ships: run `migrate deploy` before sending traffic.
- New dependencies need approval; install with an exact pin.

## Boundaries
- Ask first: migrations, public API changes, CI config.
- Never: commit `.env`, edit `src/generated/`.
