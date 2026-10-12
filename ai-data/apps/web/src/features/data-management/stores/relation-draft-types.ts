import type { CatalogRelation, RelationPublishInput } from "@ai-data/contracts";
/** 画布关系保留批准方向与服务端版本，待发布状态只属于当前编辑会话。 */
type RelationView = {
  key: string;
  relation: CatalogRelation;
  change?: RelationPublishInput["changes"][number]["action"];
};
/** 尚在属性面板编辑的连线只用于预览，应用后才进入待发布清单。 */
type RelationPreview = { source: string; target: string; description: string; key: string };
export type { RelationView, RelationPreview };
