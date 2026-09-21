import { describe, expect, it } from "vitest";
import {
  agentDefinitionSchema,
  agentVersionSchema,
  modelConfigurationInputSchema,
  modelConfigurationSchema,
  createConversationSchema,
} from "../../src/index";

const definition = {
  agent_id: "outpatient",
  version: 1,
  name: "门诊分析",
  model_id: "local",
  model_version: 1,
  tool_names: ["read_skill_reference"],
  skill_names: ["query-dsl"],
  limits: { timeout_ms: 180000, max_tool_calls: 30, max_context_bytes: 65536 },
};

describe("Agent 配置与模型合同", () => {
  it("完整配置以及空 Skill 和工具配置都可保存", () => {
    expect(agentDefinitionSchema.parse(definition).description).toBe("");
    expect(
      agentDefinitionSchema.parse({ ...definition, skill_names: [], tool_names: [] }).tool_names,
    ).toEqual([]);
    expect(
      agentVersionSchema.parse({ ...definition, skill_fingerprint: "a".repeat(64), enabled: true })
        .version,
    ).toBe(1);
  });
  it("拒绝未知字段、重复资源、无效版本及不能读取子文档的配置", () => {
    for (const input of [
      { ...definition, extra: true },
      { ...definition, version: 0 },
      { ...definition, skill_names: ["../a"] },
      { ...definition, tool_names: ["read_skill_reference", "read_skill_reference"] },
      { ...definition, skill_names: ["query-dsl", "query-dsl"] },
      { ...definition, tool_names: [] },
      { ...definition, limits: { ...definition.limits, timeout_ms: 0 } },
    ])
      expect(agentDefinitionSchema.safeParse(input).success).toBe(false);
  });
  it("模型输入接收认证，公开模型记录只暴露认证状态", () => {
    const input = {
      model_id: "local",
      version: 1,
      name: "本地模型",
      protocol: "responses",
      base_url: "http://127.0.0.1:8000/v1",
      model: "configured",
      api_key: "test-only",
      headers: { "x-api-key": "test-header" },
    };
    expect(modelConfigurationInputSchema.parse(input).api_key).toBe("test-only");
    expect(
      modelConfigurationSchema.safeParse({
        ...input,
        enabled: true,
        has_api_key: true,
        header_names: ["x-api-key"],
      }).success,
    ).toBe(false);
    const { api_key, headers, ...publicInput } = input;
    expect(api_key).toBeTruthy();
    expect(headers).toBeTruthy();
    expect(
      modelConfigurationSchema.parse({
        ...publicInput,
        enabled: true,
        has_api_key: true,
        header_names: ["x-api-key"],
      }).has_api_key,
    ).toBe(true);
  });
  it("模型地址和认证头拒绝内嵌凭据与换行，版本选择依赖 Agent 标识", () => {
    const model = {
      model_id: "local",
      version: 1,
      name: "本地",
      protocol: "responses",
      model: "m",
      base_url: "http://localhost/v1",
    };
    for (const input of [
      { ...model, base_url: "file:///tmp/model" },
      { ...model, base_url: "http://user:password@localhost/v1" },
      { ...model, headers: { "x-test": "a\nb" } },
    ])
      expect(modelConfigurationInputSchema.safeParse(input).success).toBe(false);
    expect(createConversationSchema.safeParse({ agent_version: 1 }).success).toBe(false);
    expect(
      createConversationSchema.parse({ agent_id: "outpatient", agent_version: 1 }).agent_id,
    ).toBe("outpatient");
  });
});
