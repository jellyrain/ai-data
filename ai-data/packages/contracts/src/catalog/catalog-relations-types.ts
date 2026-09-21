import type { z } from "zod";
import type {
  publishedRelationInputSchema,
  catalogRelationSchema,
  relationPublishInputSchema,
  relationGraphSchema,
} from "./catalog-relations";
/** 管理员发布的完整关系定义。 */
type PublishedRelationInput = z.infer<typeof publishedRelationInputSchema>;
/** 当前版本的独立关系记录。 */
type CatalogRelation = z.infer<typeof catalogRelationSchema>;
/** 原子批量发布输入。 */
type RelationPublishInput = z.infer<typeof relationPublishInputSchema>;
/** 指定对象的一层关系图。 */
type RelationGraph = z.infer<typeof relationGraphSchema>;
export type { PublishedRelationInput, CatalogRelation, RelationPublishInput, RelationGraph };
