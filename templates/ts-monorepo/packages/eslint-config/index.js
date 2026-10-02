import js from "@eslint/js";
import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

/** Every package: recommended rules; build output and generated code are not linted. */
export const base = tseslint.config(
  { ignores: ["dist/**", "coverage/**", "src/generated/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // A leading underscore marks a parameter that must exist but is unused (Express error handlers).
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
);

// Import sources that browser and domain code must never reach, as one regular expression:
// the database package (by name or by path), server code, and every Node builtin (bare or `node:`).
const forbidden = [
  "@repo/db(/.*)?",
  ".*/packages/db(/.*)?",
  ".*/db/src(/.*)?",
  ".*/server/.*",
  ".*/api/src(/.*)?",
  `(node:)?(${builtinModules.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(/.*)?`,
  "node:.*",
];
const source = `^(${forbidden.join("|")})$`;

// Inside an esquery selector the slashes of the expression are escaped.
const selectorRegex = source.replaceAll("/", "\\/");

const MESSAGE =
  "Browser and domain code must not import the database, server code or Node modules. Share through a package, or `import type`.";

/**
 * The boundary: import restrictions for code that runs in the browser (`src/client`) or must stay pure
 * (`src/domain`). `import type` stays allowed so the client can use the server's router types.
 */
export const boundary = {
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          { regex: source, message: MESSAGE, allowTypeImports: true },
        ],
      },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: `ImportExpression[source.type='Literal'][source.value=/${selectorRegex}/]`,
        message: MESSAGE,
      },
      {
        selector: `ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.cooked=/${selectorRegex}/]`,
        message: MESSAGE,
      },
      {
        selector: `CallExpression[callee.name='require'][arguments.0.value=/${selectorRegex}/]`,
        message: MESSAGE,
      },
    ],
  },
};

/** Browser code: base rules plus the boundary. */
export const client = tseslint.config(base, boundary);
