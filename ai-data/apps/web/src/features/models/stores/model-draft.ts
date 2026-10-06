import { modelConfigurationInputSchema, type ModelConfiguration } from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";
import type { ModelDraft } from "./model-draft-types";
function emptyModel(): ModelDraft {
  return {
    model_id: "",
    version: 1,
    name: "",
    base_url: "",
    model: "",
    authentication: "none",
    api_key: "",
    headers: [],
    authentication_confirmed: false,
  };
}
/** 复制公开配置时清空认证值，认证方式提示来自旧版本的存在标记。 */
function modelDraft(value: ModelConfiguration, version: number): ModelDraft {
  return {
    ...emptyModel(),
    model_id: value.model_id,
    version,
    name: value.name,
    base_url: value.base_url,
    model: value.model,
    context_window: value.context_window,
    authentication: value.has_api_key
      ? value.header_names.length
        ? "both"
        : "key"
      : value.header_names.length
        ? "headers"
        : "none",
    headers: value.header_names.map((name) => ({ name, value: "" })),
  };
}
function modelInput(draft: ModelDraft) {
  if (!draft.authentication_confirmed)
    throw new ApiError("请确认本版本的完整认证配置", 400, "INVALID_INPUT");
  const hasKey = ["key", "both"].includes(draft.authentication),
    hasHeaders = ["headers", "both"].includes(draft.authentication);
  if (
    hasHeaders &&
    (!draft.headers.length ||
      new Set(draft.headers.map((row) => row.name.toLowerCase())).size !== draft.headers.length)
  )
    throw new ApiError("请求头至少填写一项，名称不能重复", 400, "INVALID_INPUT");
  return modelConfigurationInputSchema.parse({
    model_id: draft.model_id,
    version: draft.version,
    name: draft.name,
    protocol: "responses",
    base_url: draft.base_url,
    model: draft.model,
    context_window: draft.context_window,
    ...(hasKey ? { api_key: draft.api_key } : {}),
    ...(hasHeaders
      ? { headers: Object.fromEntries(draft.headers.map((row) => [row.name, row.value])) }
      : {}),
  });
}
export { emptyModel, modelDraft, modelInput };
