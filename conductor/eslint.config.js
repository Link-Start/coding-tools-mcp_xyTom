import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "eslint.config.js", "test/fixtures/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-deprecated": "off",
    },
  },
  {
    files: ["src/workspace/**/*.ts", "src/cli/setup*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/workspace/**/*.ts", "src/cli/setup*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "execa",
              "message": "Only workspace/ and setup wizard modules may run git/shell directly. Use the lower MCP backend elsewhere."
            }
          ]
        }
      ]
    }
  }
);
