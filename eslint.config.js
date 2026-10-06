import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { builtinModules } from "node:module";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "coverage/",
      "test-results/",
      "playwright-report/",
      ".implement/",
      ".mastermind/",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./packages/*/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["packages/cli/src/**/*.tsx"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
  },
  {
    files: ["packages/core/src/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^(node:.*|${builtinModules.join("|")})(/.*)?$`,
              message: "Contracts are shared with the browser and must not import Node modules.",
            },
          ],
        },
      ],
    },
  },
);
