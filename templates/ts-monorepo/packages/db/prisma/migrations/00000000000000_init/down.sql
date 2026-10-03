-- Reverts migration.sql (schema only, the rows of "Account" are gone: restore them from a backup).
-- Run by `pnpm --filter @repo/db migrate:down`, never by `migrate deploy`.
SET lock_timeout = '5s';

DROP TABLE "Account";
