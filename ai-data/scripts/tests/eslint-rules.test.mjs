import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";
import { ESLint } from "eslint";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: workspace });

test("Vue SFC 允许公共共享入口并检查纯类型导入", async () => {
  const valid =
    '<script setup lang="ts">import type { Dataset } from "@ai-data/contracts"; defineProps<{ dataset: Dataset }>();</script><template><div>{{ dataset }}</div></template>';
  assert.deepEqual(await lint(valid, "apps/web/src/rule-example.vue"), []);
  const messages = await lint(
    valid.replace("import type", "import"),
    "apps/web/src/rule-example.vue",
  );
  assert.ok(
    messages.some((message) => message.ruleId === "@typescript-eslint/consistent-type-imports"),
  );
});
test("Vue SFC 禁止跨应用和共享包内部导入", async () => {
  for (const path of ["../../api/src/app", "@ai-data/contracts/src/catalog/dataset"]) {
    const messages = await lint(
      `<script setup lang="ts">import { value } from "${path}";</script><template><div>{{ value }}</div></template>`,
      "apps/web/src/rule-example.vue",
    );
    assert.ok(messages.some((message) => message.ruleId === "workspace/import-boundaries"));
  }
});
/** 通过实际工作区配置检查虚拟源码，不写入应用目录。 */
async function lint(source, relativePath = "apps/api/src/rule-example.ts") {
  const [result] = await eslint.lintText(source, { filePath: resolve(workspace, relativePath) });
  return result.messages;
}

test("仅作为类型使用的导入必须标记为类型导入", async () => {
  const messages = await lint(
    'import { Dataset } from "@ai-data/contracts"; export type Example = Dataset;',
  );
  assert.ok(
    messages.some((message) => message.ruleId === "@typescript-eslint/consistent-type-imports"),
  );
});

for (const source of [
  'import type { Dataset } from "@ai-data/contracts"; export type Example = Dataset;',
  'import { datasetSchema, type Dataset } from "@ai-data/contracts"; export const parse = (input: unknown): Dataset => datasetSchema.parse(input);',
  'export { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";',
  'export { createApp } from "./app";',
  'export { ApplicationError } from "../../src/errors/application-error";',
])
  test("合法导入通过: " + source, async () => {
    assert.deepEqual(
      await lint(
        source,
        source.includes("../../src/") ? "apps/api/tests/routes/rule-example.ts" : undefined,
      ),
      [],
    );
  });

for (const source of [
  'export { datasetSchema } from "@ai-data/contracts/src/catalog/dataset";',
  'export { SqlServerMetadataDatabase } from "@ai-data/metadata/private";',
  'export { datasetSchema } from "../../../packages/contracts/src/catalog/dataset";',
  'export { createApp } from "../../data-access/src/app";',
  'export { createApp } from "@ai-data/data-access";',
  'export const load = () => import("../../data-access/src/app");',
  'export type Example = import("@ai-data/contracts/src/catalog/dataset-types").Dataset;',
])
  test("越过模块边界的引用被拒绝: " + source, async () => {
    const messages = await lint(source);
    assert.ok(
      messages.some((message) => message.ruleId === "workspace/import-boundaries"),
      JSON.stringify(messages),
    );
  });

test("规则对包目录执行 lint 和绝对导入路径同样生效", async () => {
  const packageLint = new ESLint({ cwd: resolve(workspace, "apps/api") });
  const [result] = await packageLint.lintText(
    `export { createApp } from ${JSON.stringify(resolve(workspace, "apps/data-access/src/app.ts"))};`,
    { filePath: resolve(workspace, "apps/api/src/rule-example.ts") },
  );
  assert.ok(result.messages.some((message) => message.ruleId === "workspace/import-boundaries"));
});

test("共享包使用自身内部相对导入", async () => {
  assert.deepEqual(
    await lint(
      'export { datasetSchema } from "./catalog/dataset";',
      "packages/contracts/src/rule-example.ts",
    ),
    [],
  );
});
