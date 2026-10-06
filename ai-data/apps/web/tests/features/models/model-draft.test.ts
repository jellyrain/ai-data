import { describe, it, expect } from "vitest";
import { modelConfigurationSchema } from "@ai-data/contracts";
import { modelDraft, modelInput } from "../../../src/features/models/stores/model-draft";
describe("模型每版本认证", () => {
  it("复制版本只保留认证方式和头名称，确认前不能提交", () => {
    const draft = modelDraft(
      modelConfigurationSchema.parse({
        model_id: "rj",
        version: 1,
        name: "模型",
        protocol: "responses",
        base_url: "http://model:8000/v1",
        model: "rj-v1",
        enabled: true,
        has_api_key: true,
        header_names: ["X-Secret"],
      }),
      2,
    );
    expect(draft.api_key).toBe("");
    expect(draft.headers).toEqual([{ name: "X-Secret", value: "" }]);
    expect(() => modelInput(draft)).toThrow("请确认");
    draft.authentication = "none";
    draft.authentication_confirmed = true;
    expect(modelInput(draft)).not.toHaveProperty("api_key");
    expect(modelInput(draft)).not.toHaveProperty("headers");
  });
});
