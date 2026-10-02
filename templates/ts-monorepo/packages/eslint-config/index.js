import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Every package: recommended rules; build output and generated code are not linted. */
export const base = tseslint.config(
  { ignores: ["dist/**", "coverage/**", "src/generated/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
);

/**
 * Browser code: no server, database or Node imports.
 * `import type` stays allowed so the client can use the server's router types.
 */
export const client = tseslint.config(base, {
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@repo/db", "@repo/db/*", "node:*"],
            message: "Browser code must not import the database or Node modules.",
            allowTypeImports: true,
          },
          {
            group: ["**/server/**", "**/api/src/**"],
            message: "Browser code must not import server code. Share through a package or `import type`.",
            allowTypeImports: true,
          },
        ],
      },
    ],
  },
});
