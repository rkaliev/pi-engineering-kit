---
name: database-changes
description: Use when writing a database migration, changing a schema, backfilling data, adding transactions or queries on a hot path, or deleting, archiving or purging data
---

# Database changes

The database outlives every release. A change is safe when the running code, the new code and a rollback all keep working, and no data is lost on the way.

## Migrations

- **Through the project's migration tool, one purpose per migration.** Never edit a migration that has run anywhere shared; add a new one.
- **Old and new code must both work with the schema after the migration.** Deploys and rollbacks overlap them. So anything that breaks the old code goes through **expand/contract**, over separate releases:
  1. **expand:** add the new column, table or index (nullable, or with a default);
  2. **migrate:** code writes both shapes and reads the new one, and the backfill runs;
  3. **contract:** drop the old shape in a later release, once nothing, including a rollback, still needs it.

  This applies to renames, drops, type changes, `NOT NULL`, and moved tables. Recipes are in `references/migration-patterns.md`.
- **Transactional** where the database supports it. A statement that can't run in a transaction (a concurrent index build) gets a comment with the reason.
- **Reversible:** a down or rollback migration restores the schema. It doesn't restore data, so a destructive step says so and names its recovery path (a backup, or a backfill from the source).
- **Locks:** set a short `lock_timeout` for the migration; build indexes concurrently; avoid rewriting large tables in one statement (check how your database handles the change).
- **Backfills** are separate, idempotent, batched jobs that can be resumed and throttled, never part of the schema migration.

## Deploying

- The order is: backup, then migrations as their own step (not in the app's start command), then the rollout, then a health check. A failed migration stops the rollout, so the old code keeps serving.
- The app refuses to start, or reports not ready, when the database lacks a migration this build needs. It tolerates newer ones, so an image rollback still boots.
- Where possible, the migrator and the running app use different database roles: the app can't alter the schema.
- Running migrations against a shared or production database needs the user's explicit yes (the guard asks).

## Verifying

Run the migrations up, and down where they exist, on a throwaway database in CI, then compare the resulting schema with the expected one (drift check). Test the backfill on realistic volumes and data shapes, including NULLs and legacy values.

## Transactions

- Dependent writes run in one transaction. Helpers take the caller's transaction instead of opening their own.
- No network calls or other side effects inside a transaction. Record them in an outbox table in the same transaction and send them after commit (see payments-and-money).
- Read-modify-write takes a row lock or uses optimistic versioning. Don't rely on the isolation level to save you.
- Timestamps such as `created_at` and `updated_at` come from the database clock.

## Queries

- Every connection has statement and lock timeouts from configuration (see observability).
- Select explicit columns. Use parameters only, never string-built SQL; identifiers come from an allowlist.
- Every list has a limit or pagination. Watch for N+1 queries.
- A new query on a hot path gets an index and a look at its plan (`EXPLAIN`).

## Deleting data

- Choose the transition deliberately: hard delete, soft delete (archive), anonymize, or purge after a retention window.
- Never hard-delete what history refers to (orders, receipts, payments, audit records): archive or suspend it instead.
- Archived rows are filtered out by default in every query that lists them.
- A purge needs a stated retention period (and the legal basis for personal data).
- The UI says what really happened: "Archive" only if the user can restore it.

## Databases on devices

Room, Core Data, SQLDelight or SQLite on mobile and POS: test the migration from **every schema version that shipped**, and never use a destructive fallback (`fallbackToDestructiveMigration`) in production. Offline queues must survive the upgrade (see pos-systems).
