# Kit demo

A tiny checkout library used to try pi-engineering-kit. Money is always integer minor units (cents).

## Stack
- TypeScript run directly by Node (built-in type stripping). Node version: see `engines` in package.json.
- No dependencies. Tests use `node:test`.

## Structure
- `src/*.ts` — pure functions, one per file
- `src/*.test.ts` — tests next to the code
- `tasks/` — task descriptions with numbered criteria

## Commands
- `npm test` — all tests

## Rules
- Money: integer minor units only. No floating-point results; see the payments-and-money skill.
- No new dependencies.
- Change only what the task needs.

## Definition of done
1. Each criterion of the task is covered by a test, and you saw the test fail before the fix.
2. `npm test` ran in this session and passed.
3. The final message lists changed files, commands run with their results, and what was not verified.

Don't say "done" if the commands weren't run.
