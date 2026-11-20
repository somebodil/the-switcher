import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
  },
  {
    // `describe` and `it` of node:test return promises that the test runner takes care of
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
]);
