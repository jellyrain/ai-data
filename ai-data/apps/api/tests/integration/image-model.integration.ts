import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { loadApiConfig } from "../../src/config/api-config";
import { createAgentConfiguration } from "../../src/agents/create-agent-configuration";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { context } from "../support/api-fixtures";
import { testImage } from "../support/test-image";

it.skipIf(process.env.IMAGE_MODEL_TEST !== "1")(
  "真实模型识别两张图片并在进程重启后回答追问",
  async () => {
    const config = loadApiConfig(
      fileURLToPath(new URL("../../config/api.config.json", import.meta.url)),
    );
    const database = await SqlServerMetadataDatabase.connect(config.metadata_sqlserver);
    const parent = resolve("secrets");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "image-model-"));
    let harness: CodexAnalysisHarness | undefined;
    try {
      const found = await database.execute({
        sql: "SELECT TOP (1) m.organization_id,m.model_id FROM dbo.model_configurations m JOIN dbo.model_configuration_versions v ON v.organization_id=m.organization_id AND v.model_id=m.model_id WHERE m.enabled=1 AND (JSON_VALUE(v.definition_json,'$.model')=@model OR JSON_VALUE(v.definition_json,'$.name')=@model) ORDER BY v.version DESC",
        parameters: [
          { name: "model", type: "string", value: process.env.IMAGE_MODEL_NAME ?? "rj-model-v2" },
        ],
      });
      assert(found.rows[0], "需要已启用的模型配置");
      const identity = { ...context, organizationId: String(found.rows[0].organization_id) };
      const services = createAgentConfiguration({
        database,
        config: config.analysis_runtime,
        startupDirectory: process.cwd(),
        skillsDirectory: fileURLToPath(new URL("../../../../packages/skills", import.meta.url)),
      });
      const selected = await services.models.get(identity, String(found.rows[0].model_id));
      const provider = await services.models.resolve(identity, selected.model_id, selected.version);
      const images = [join(directory, "one.png"), join(directory, "two.png")];
      await writeFile(images[0]!, testImage(128, 128, [255, 0, 0]));
      await writeFile(images[1]!, testImage(128, 128, [0, 255, 0]));
      const options = {
        provider,
        stateDirectory: directory,
        contextWindow: provider.contextWindow ?? 32768,
        timeoutMs: 180000,
      };
      harness = new CodexAnalysisHarness(options);
      let threadId: string | undefined;
      const run = (input: string, paths: string[]) =>
        harness!.run({
          sessionKey: "image-real",
          threadId,
          input,
          images: paths.map((path, index) => ({ path, label: `第 ${index + 1} 张图片` })),
          instructions: "请直接用中文回答图片问题。",
          tools: [],
          signal: new AbortController().signal,
          onThreadStarted: async (id) => {
            if (threadId) expect(id).toBe(threadId);
            threadId = id;
          },
          executeTool: async () => ({ success: false, output: {} }),
        });
      const first = await run("按顺序说出两张图的主要颜色。", images);
      expect(first).toMatchObject({ status: "completed" });
      expect(first.status === "completed" && first.content).toMatch(/红/);
      expect(first.status === "completed" && first.content).toMatch(/绿/);
      await harness.close();
      harness = new CodexAnalysisHarness(options);
      const next = await run("上一轮一共给了几张图？第二张什么颜色？", []);
      expect(next).toMatchObject({ status: "completed" });
      expect(next.status === "completed" && next.content).toMatch(/2|两|二/);
      expect(next.status === "completed" && next.content).toMatch(/绿/);
    } finally {
      await harness?.close();
      await database.close();
      assert.equal(dirname(directory), parent);
      await rm(directory, { recursive: true, force: true });
    }
  },
  400000,
);
