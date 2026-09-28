"use strict";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import jsdoc from "eslint-plugin-jsdoc";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      globals: Object.assign(Object.assign({}, globals.node), globals.es2021),
    },
    rules: {
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["src/Agents/tools/*.ts"],
    plugins: {
      jsdoc
    },
    rules: {
      "jsdoc/require-jsdoc": ["error", {
        require: { ClassDeclaration: true, MethodDefinition: true, FunctionDeclaration: true, ArrowFunctionExpression: false, FunctionExpression: false }
      }]
    }
  },
  {
    // Paths cleaned of `any` as part of the type-safety cleanup program —
    // see docs/TYPE_SAFETY_CLEANUP.md. Enforced as an error here (rather
    // than the repo-wide "warn") so these security-sensitive paths don't
    // silently regress. Extend this list as more directories are cleaned.
    files: [
      "packages/bot/src/permissions/**/*.ts",
      "packages/bot/src/commands/middleware/**/*.ts",
      "packages/bot/src/commands/services/BackendClient.ts",
      "packages/bot/src/moderation/**/*.ts",
      "packages/bot/src/commands/adapters/telegramModeration.ts",
      "packages/sdk/src/xdrDecoder.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "build/**"],
  },
    {
        ignores: ["node_modules/**", "dist/**", "build/**", "packages/bot/src/**/*.js"]
    }
];
