import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import { importBoundaries } from "./scripts/eslint/import-boundaries.mjs";

// 统一 JavaScript 与 TypeScript 的推荐检查规则，生成产物不参与源码检查。
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/secrets/**",
      "release/**",
      "apps/web/test-results/**",
      "apps/web/playwright-report/**",
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    files: ["apps/web/**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] },
    },
    rules: {
      "vue/multi-word-component-names": "off",
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,vue}"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        BroadcastChannel: "readonly",
        localStorage: "readonly",
        matchMedia: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        console: "readonly",
      },
    },
  },

  {
    plugins: { workspace: { rules: { "import-boundaries": importBoundaries } } },
    rules: { "workspace/import-boundaries": "error" },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },

  // 最后关闭与 Prettier 冲突的格式规则，将排版交给格式化工具。
  prettier,
);
