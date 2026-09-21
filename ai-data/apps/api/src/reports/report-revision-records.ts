import { z } from "zod";
import { reportDefinitionSchema } from "@ai-data/contracts";
const id = z.string().min(1).max(128);
/** 编辑目标由 API 持久化，模型提交内容不能改变目标或基准版本。 */
const reportEditContextSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("revision"),
      report_id: id,
      expected_version: z.number().int().nonnegative(),
      definition: reportDefinitionSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("narrative"),
      report_id: id,
      expected_version: z.number().int().positive(),
      execution_id: id,
    })
    .strict(),
]);
/** 普通会话可新建报表，修改已有报表必须通过绑定目标的修改入口。 */
const stageReportDefinitionSchema = z
  .object({
    definition: reportDefinitionSchema,
    report_id: id.optional(),
    expected_version: z.number().int().positive().optional(),
  })
  .strict();
export { reportEditContextSchema, stageReportDefinitionSchema };
