import tseslint from "typescript-eslint";
import da from "@dynamicagents/core/eslint";

const LINTED_FILES = ["src/**/*.ts", "test/**/*.ts"];

export default tseslint.config(
  {
    extends: [...tseslint.configs.recommended],
    files: LINTED_FILES,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-expressions": "off",
      // The Agents SDK's `this.sql`…`` statements are tagged templates run for
      // their side effect (CREATE TABLE / INSERT); keep the rule for everything
      // else.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    // The rule that keeps each agent's module graph its own. An agent may import
    // core, the plugins it installs, and its own directory — never a sibling
    // agent's internals. Without it, one convenience import quietly puts a
    // sibling's plugins in this agent's bundle and `npm run verify:isolation`
    // starts failing in CI with no obvious cause.
    //
    // Banning the `@/agents/*` alias outright is safe because no file uses it —
    // an agent reaches its own modules by relative path.
    files: ["src/agents/*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/agents/*"],
              message:
                "An agent must not reach into another agent's modules — that is what puts their " +
                "plugins in its bundle. Anything genuinely shared belongs in src/config.ts or " +
                "src/round-policy.ts. Use a relative path for this agent's own modules."
            }
          ]
        }
      ]
    }
  },
  {
    // Type-aware pass — enables @deprecated detection without switching the
    // whole config to recommendedTypeChecked and its stricter rule set.
    files: LINTED_FILES,
    plugins: { "@typescript-eslint": tseslint.plugin, da },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      // Covers the object-literal keys `no-deprecated` structurally cannot see —
      // i.e. every `generateText({ system: … })`-style options bag.
      "da/no-deprecated-object-properties": "error"
    }
  },
  {
    ignores: [
      "worker-configuration.d.ts",
      "node_modules/",
      ".wrangler/",
      "dist/"
    ]
  }
);
