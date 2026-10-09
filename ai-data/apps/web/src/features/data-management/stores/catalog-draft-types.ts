import type { ApiDatasetConfig } from "@ai-data/contracts";
/** 业务表单直接编辑结构化配置，保留省略与显式空集合。 */
type CatalogDraft = {
  config: ApiDatasetConfig;
};
export type { CatalogDraft };
