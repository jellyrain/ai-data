import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import { importBoundaries } from "./scripts/eslint/import-boundaries.mjs";

// 统一 JavaScript 与 TypeScript 的推荐检查规则，生成产物不参与源码检查。
export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "release/**"],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

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
