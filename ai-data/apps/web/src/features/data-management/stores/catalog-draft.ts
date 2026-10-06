import { apiDatasetConfigSchema, type AdminDatasetDetail } from "@ai-data/contracts";
import { parseManagementJson } from "./object-selection";
import type { CatalogDraft } from "./catalog-draft-types";
function catalogDraft(detail: AdminDatasetDetail): CatalogDraft {
  const config = apiDatasetConfigSchema.parse(
    detail.config ?? { source_id: detail.dataset.source_id, object_id: detail.dataset.object_id },
  );
  return {
    config,
    capabilities:
      config.query_capabilities === undefined
        ? ""
        : JSON.stringify(config.query_capabilities, null, 2),
    parameters:
      config.query_parameter_policies === undefined
        ? ""
        : JSON.stringify(config.query_parameter_policies, null, 2),
    bindings:
      config.query_permission_bindings === undefined
        ? ""
        : JSON.stringify(config.query_permission_bindings, null, 2),
  };
}
/** 只替换表单对应字段，approved_relations 和其他配置沿用读取的完整基准。 */
function catalogInput(draft: CatalogDraft) {
  return apiDatasetConfigSchema.parse({
    ...draft.config,
    query_capabilities: draft.capabilities.trim()
      ? parseManagementJson(draft.capabilities, "查询能力")
      : undefined,
    query_parameter_policies: draft.parameters.trim()
      ? parseManagementJson(draft.parameters, "参数策略")
      : undefined,
    query_permission_bindings: draft.bindings.trim()
      ? parseManagementJson(draft.bindings, "权限参数绑定")
      : undefined,
  });
}
export { catalogDraft, catalogInput };
