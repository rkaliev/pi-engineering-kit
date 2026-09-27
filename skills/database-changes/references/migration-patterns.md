# Migration patterns

Each pattern is split across releases so that the running version and a rollback always work.

| Change | Release 1 (expand) | Release 2 (migrate) | Release 3 (contract) |
|---|---|---|---|
| Rename a column | add the new column; write both | backfill; read the new one | drop the old column |
| Drop a column | stop reading and writing it in code | (nothing) | drop the column |
| Change a type | add a new column of the new type; write both | backfill with conversion; read the new one | drop the old; rename if needed (itself an expand/contract) |
| Add `NOT NULL` | add nullable; code always writes it | backfill; add a `CHECK … NOT VALID`, then validate it | set `NOT NULL` (cheap once validated) |
| Add a unique constraint | build the unique index concurrently | fix duplicates found | attach the constraint to the index |
| Split a table | create the new table; write both | backfill; read the new one | drop the moved columns |
| Add an index | `CREATE INDEX CONCURRENTLY` (PostgreSQL) or the online option of your database | | |

## Lock notes

- **PostgreSQL:**
  - Set `lock_timeout` (for example 1 s) and retry, so a migration never queues behind a long transaction and blocks everyone.
  - Adding a column with a constant default is cheap from version 11 on. A volatile default rewrites the table.
  - `ALTER TYPE` usually rewrites the table.
  - `CREATE INDEX CONCURRENTLY` can't run inside a transaction.
- **MySQL:**
  - Prefer `ALGORITHM=INSTANT` or `INPLACE`, `LOCK=NONE`, and check which changes support them.
  - For large tables use an online schema tool (gh-ost, pt-online-schema-change).
- **SQLite and device databases:**
  - Many changes need the table-rebuild pattern (create, copy, drop, rename) inside a transaction.
  - Keep migrations small, because they run on the user's device at app start.

## Backfill template

```text
- Selects rows in primary-key batches (e.g. 1 000), where the new value is still missing (so re-runs are safe)
- Updates the batch in its own short transaction
- Sleeps between batches or respects a rate limit; stops on high replication lag or lock waits
- Logs progress (last key, rows done) and can resume from the last key
- Has a dry-run mode that only counts
- Ends with a verification query: rows still missing = 0
```
