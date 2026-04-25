import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/", "coverage/", "**/__fixtures__/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "warn",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
);
