import { base, client } from "@repo/eslint-config";

export default [...base, ...client.map((config) => ({ ...config, files: ["src/client/**/*.{ts,tsx}"] }))];
