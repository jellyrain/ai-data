import { z } from "zod";
import { queryEvidenceSchema } from "../evidence/evidence";
import { dateTimeSchema } from "../shared/data-values";

const id = z.string().min(1).max(128);
/** 报告块从关联证据渲染表格与图表；文字同样声明证据来源。 */
const reportBlockSchema = z
  .object({
    block_id: id,
    type: z.enum(["text", "table", "chart"]),
    title: z.string().min(1).max(512),
    evidence_ids: z
      .array(id)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "证据引用不能重复"),
    content: z.string().max(64000).optional(),
    /** 表格展示列顺序；省略时显示来源结果全部列。 */
    columns: z.array(id).min(1).max(200).optional(),
    chart: z
      .object({ type: z.enum(["line", "bar", "pie"]), x: id, y: id })
      .strict()
      .optional(),
  })
  .strict()
  .refine((block) => block.type !== "chart" || block.chart !== undefined, "图表块必须声明坐标字段")
  .refine((block) => block.type !== "text" || Boolean(block.content?.trim()), "文字块必须提供内容");
const reportSectionSchema = z
  .object({
    section_id: id,
    title: z.string().min(1).max(512),
    blocks: z.array(reportBlockSchema).min(1).max(100),
  })
  .strict();
/** 报告创建与版本更新输入；组织、创建人和证据快照由 API 填充。 */
const saveReportInputSchema = z
  .object({
    analysis_run_id: id,
    title: z.string().min(1).max(512),
    sections: z
      .array(reportSectionSchema)
      .min(1)
      .max(100)
      .superRefine((sections, context) => {
        const sectionIds = sections.map((section) => section.section_id);
        const blockIds = sections.flatMap((section) =>
          section.blocks.map((block) => block.block_id),
        );
        if (
          new Set(sectionIds).size !== sectionIds.length ||
          new Set(blockIds).size !== blockIds.length
        )
          context.addIssue({ code: "custom", message: "章节与块标识必须在报告内唯一" });
      }),
    shared_with: z.array(id).max(1000).default([]),
  })
  .strict();
/** 版本化报告包含完整来源快照，访问需同时满足报告权限与当前数据权限。 */
const savedReportSchema = saveReportInputSchema
  .extend({
    report_id: id,
    version: z.number().int().positive(),
    organization_id: id,
    user_id: id,
    created_at: dateTimeSchema,
    /** 公共执行生成的快照关联固定定义版本；历史人工快照可以省略。 */
    definition_version: z.number().int().positive().optional(),
    execution_id: id.optional(),
    sources: z
      .array(queryEvidenceSchema)
      .min(1)
      .max(1000)
      .refine(
        (sources) => new Set(sources.map((source) => source.evidence_id)).size === sources.length,
        "来源证据不能重复",
      ),
  })
  .strict()
  .superRefine((report, context) => {
    const sources = new Set(report.sources.map((source) => source.evidence_id));
    for (const section of report.sections)
      for (const block of section.blocks)
        if (block.evidence_ids.some((evidence) => !sources.has(evidence)))
          context.addIssue({ code: "custom", message: "报告块引用的证据必须包含在快照中" });
    if (
      report.sources.some(
        (source) =>
          source.organization_id !== report.organization_id ||
          source.analysis_run_id !== report.analysis_run_id,
      )
    )
      context.addIssue({ code: "custom", message: "报告来源须属于同一组织及运行" });
  });

export { reportBlockSchema, reportSectionSchema, saveReportInputSchema, savedReportSchema };
