import { z } from "zod";
import { queryResultTableSchema } from "../query/query-result";

/** 所有 SSE 事件共有的关联字段。 */
const eventBaseSchema = z
  .object({
    /** 事件所属会话，用于关联前端会话视图。 */
    conversation_id: z.string().min(1, "conversation_id 不能为空"),

    /** 事件所属分析运行，用于区分同一会话中的多次分析。 */
    analysis_run_id: z.string().min(1, "analysis_run_id 不能为空"),

    /** 运行内事件序号；本层检查非负整数，递增顺序由事件生产方维护。 */
    sequence: z.number().int().nonnegative(),
  })
  .strict();

/**
 * API 向 Web 推送的流式事件合同。
 * 通过 type 选择对应载荷结构，前端据此分发渲染。
 * 事件根对象与澄清选项对象拒绝未知字段，表格载荷复用查询结果的一致性约束。
 */
const sseEventSchema = z
  .discriminatedUnion("type", [
    /** 分析运行已创建。 */
    eventBaseSchema.extend({
      type: z.literal("run_started"),
    }),

    /** Agent 或工具执行过程中的进度信息。 */
    eventBaseSchema.extend({
      type: z.literal("progress"),
      /** 面向用户展示的当前进度。 */
      message: z.string(),
    }),

    /** 面向用户展示的分析思考摘要；不承载模型内部完整推理链。 */
    eventBaseSchema.extend({
      type: z.literal("thinking"),
      /** 当前分析阶段，供前端分阶段渲染。 */
      stage: z.enum(["understanding", "planning", "querying", "validating", "summarizing"]),
      /** 用户可读的分析摘要。 */
      content: z.string().min(1),
    }),

    /** Agent 调用工具。 */
    eventBaseSchema.extend({
      type: z.literal("tool_call"),
      /** 被调用的工具名称。 */
      tool_name: z.string().min(1),
      /** 脱敏后的工具输入摘要。 */
      input_summary: z.string(),
    }),

    /** 工具调用返回。 */
    eventBaseSchema.extend({
      type: z.literal("tool_result"),
      /** 返回结果对应的工具名称。 */
      tool_name: z.string().min(1),
      /** 工具是否成功完成。 */
      success: z.boolean(),
      /** 脱敏后的工具输出摘要。 */
      output_summary: z.string(),
    }),

    /** 模型需要用户选择时推送的选项事件；问题和选项内容由模型生成。 */
    eventBaseSchema.extend({
      type: z.literal("clarification"),
      /** 模型生成的待确认问题。 */
      question: z.string().min(1),
      /** 前端渲染并回传的选项。 */
      options: z.array(
        z
          .object({
            /** 回传给 API 的选项标识。 */
            id: z.string().min(1),
            /** 前端展示文本。 */
            label: z.string().min(1),
          })
          .strict(),
      ),
      /** 是否允许用户输入自定义内容。 */
      allow_custom_input: z.boolean(),
    }),

    /** 最终自然语言结论。 */
    eventBaseSchema.extend({
      type: z.literal("final_answer"),
      /** 最终自然语言结论正文。 */
      content: z.string(),
    }),

    /** 将结构化查询结果推送给前端表格渲染。 */
    eventBaseSchema.extend({
      type: z.literal("table"),
      /** 表格列定义。 */
      columns: queryResultTableSchema.shape.columns,
      /** 表格数据行。 */
      rows: queryResultTableSchema.shape.rows,
    }),

    /** 将图表配置推送给前端渲染。 */
    eventBaseSchema.extend({
      type: z.literal("chart"),
      /** 前端渲染器支持的图表类型。 */
      chart_type: z.enum(["line", "bar", "pie", "table"]),
      /** 经 API 校验的图表配置。 */
      spec: z.record(z.string(), z.unknown()),
    }),

    /** 分析运行正常结束。 */
    eventBaseSchema.extend({
      type: z.literal("run_completed"),
    }),

    /** 分析运行失败，并提供稳定错误码。 */
    eventBaseSchema.extend({
      type: z.literal("run_failed"),
      /** 稳定错误码，供前端和日志分类。 */
      code: z.string().min(1),
      /** 面向用户的错误说明。 */
      message: z.string().min(1),
    }),

    /** 用户或系统主动取消分析。 */
    eventBaseSchema.extend({
      type: z.literal("run_cancelled"),
    }),
  ])
  .superRefine((event, context) => {
    if (event.type !== "table") return;
    const result = queryResultTableSchema.safeParse({ columns: event.columns, rows: event.rows });
    if (!result.success)
      result.error.issues.forEach((issue) =>
        context.addIssue({ code: "custom", path: issue.path, message: issue.message }),
      );
  });

export { sseEventSchema };
