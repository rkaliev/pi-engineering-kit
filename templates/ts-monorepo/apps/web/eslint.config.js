import { base, boundary } from "@repo/eslint-config";

// The boundary holds for browser code and for the pure domain; tests may use Node.
export default [
  ...base,
  {
    ...boundary,
    files: ["src/client/**/*.{ts,tsx}", "src/domain/**/*.ts"],
    ignores: ["**/*.test.{ts,tsx}"],
  },
];
