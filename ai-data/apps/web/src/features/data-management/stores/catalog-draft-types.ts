import type { ApiDatasetConfig } from "@ai-data/contracts";
/** 高级段保留原 JSON 的省略语义，只有保存时才解析进完整业务配置。 */
type CatalogDraft = {
  config: ApiDatasetConfig;
  capabilities: string;
  parameters: string;
  bindings: string;
};
export type { CatalogDraft };
