/**
 * Present in any bundle that includes this package. The web build fails when it finds the string in `dist/`
 * (apps/web/scripts/check-bundle.ts), so the database client can never ship to the browser.
 */
export const SERVER_ONLY_MARKER = "repo-db-server-only-marker";

// A side effect, so a bundler cannot drop the string as unused code.
(globalThis as Record<string, unknown>)[SERVER_ONLY_MARKER] = true;
