import { z } from "zod";
import { approvedRelationSchema } from "./api-dataset";
import { dateTimeSchema } from "../shared/data-values";

const id = z.string().min(1).max(128);
const identifier = z.string().regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_.$]*$/u);
/** 新发布关系始终有稳定 ID 和明确连接能力；方向固定为 object_id 到 target_object_id。 */
const publishedRelationInputSchema = approvedRelationSchema.extend({
  relation_id: identifier.max(128),
  target_object_id: identifier.max(256),
  allowed_join_types: z
    .array(z.enum(["inner", "left", "right"]))
    .min(1)
    .max(3),
});
/** 独立关系记录保留版本及启停状态，列对与唯一键证明由发布服务校验。 */
const catalogRelationSchema = publishedRelationInputSchema.extend({
  source_id: id,
  object_id: identifier.max(256),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  updated_at: dateTimeSchema,
});
/** 批量发布逐项声明操作，遗漏的旧关系保持原状；同一标识在一批中只能操作一次。 */
const relationPublishInputSchema = z
  .object({
    changes: z
      .array(
        z.discriminatedUnion("action", [
          z
            .object({
              action: z.literal("create"),
              object_id: identifier.max(256),
              relation: publishedRelationInputSchema,
            })
            .strict(),
          z
            .object({
              action: z.literal("update"),
              object_id: identifier.max(256),
              expected_version: z.number().int().positive(),
              relation: publishedRelationInputSchema,
            })
            .strict(),
          z
            .object({
              action: z.literal("disable"),
              object_id: identifier.max(256),
              relation_id: identifier.max(128),
              expected_version: z.number().int().positive(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.changes.map(
      (change) =>
        `${change.object_id}:${change.action === "disable" ? change.relation_id : change.relation.relation_id}`,
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "一批中不能重复修改同一关系" });
  });
/** 一层关系图只描述批准方向，入边供浏览使用，不隐式授权反向连接。 */
const relationGraphSchema = z
  .object({
    source_id: id,
    object_id: identifier.max(256),
    outgoing: z.array(catalogRelationSchema),
    incoming: z.array(catalogRelationSchema),
  })
  .strict();

export {
  publishedRelationInputSchema,
  catalogRelationSchema,
  relationPublishInputSchema,
  relationGraphSchema,
};
