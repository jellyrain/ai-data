import { apiDatasetConfigSchema, type AdminDatasetDetail, type Dataset } from "@ai-data/contracts";
import { validateCapabilities, validateParameterSettings } from "./capability-editor";
import type { CatalogDraft } from "./catalog-draft-types";
function catalogDraft(detail: AdminDatasetDetail): CatalogDraft {
  const config = apiDatasetConfigSchema.parse(
    detail.config ?? { source_id: detail.dataset.source_id, object_id: detail.dataset.object_id },
  );
  return { config };
}
/** 只替换表单对应字段，approved_relations 和其他配置沿用读取的完整基准。 */
function catalogInput(draft: CatalogDraft, dataset?: Dataset) {
  if (dataset) {
    validateCapabilities(
      draft.config.query_capabilities,
      dataset.columns,
      dataset.query_capabilities,
    );
    validateParameterSettings(
      dataset,
      draft.config.query_parameter_policies,
      draft.config.query_permission_bindings,
    );
  }
  return apiDatasetConfigSchema.parse(draft.config);
}
export { catalogDraft, catalogInput };
