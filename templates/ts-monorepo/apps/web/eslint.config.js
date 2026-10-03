import { base, boundary } from "@repo/eslint-config";

const extensions = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

// The boundary holds for browser code and for the pure domain; tests may use Node.
export default [
  ...base,
  {
    ...boundary,
    files: [`src/client/**/*.${extensions}`, `src/domain/**/*.${extensions}`],
    ignores: [`**/*.test.${extensions}`],
  },
];
