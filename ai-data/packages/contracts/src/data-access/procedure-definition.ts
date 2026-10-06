import { datasetColumnSchema, queryParameterSchema } from "../catalog/dataset";
import { dataTypeSchema } from "../shared/data-values";
import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/);

/** PostgreSQL 可显式绑定的原生参数类型白名单，用于确定同名过程的准确签名。 */
const postgresqlParameterTypeSchema = z.enum([
  "text",
  "varchar",
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "boolean",
  "date",
  "timestamp",
  "bytea",
]);

/** PostgreSQL OUT-only 参数占用完整调用签名的位置；输入和 INOUT 参数由 query_parameters 顺序提供。 */
const procedureOutputParameterSchema = z
  .object({
    /** 管理员核对的 OUT 参数名。 */
    name: identifierSchema,
    /** 管理员核对的 OUT 参数类型，结果列同时声明并验证其实际类型。 */
    data_type: dataTypeSchema,
    /** 包含全部输入和输出参数后的零基位置。 */
    position: z.number().int().min(0).max(1023),
  })
  .strict();

/** 管理员审核的固定过程签名；参数顺序对应数据库声明顺序，仅接受声明字段。 */
const procedureDefinitionSchema = z
  .object({
    /** 按数据库声明顺序排列的 IN 和 INOUT 参数；显式默认值由 DAS 绑定。 */
    query_parameters: z.array(queryParameterSchema).max(1024),
    /** 必须完整列出单一表格结果的全部列，空集合无法证明固定输出。 */
    columns: z.array(datasetColumnSchema).min(1),
    /** PostgreSQL OUT-only 参数；省略表示调用签名全部是输入或 INOUT 参数。 */
    output_parameters: z.array(procedureOutputParameterSchema).max(1024).optional(),
    /** PostgreSQL 每个 IN/INOUT 参数的原生类型，按 query_parameters 顺序声明；其他数据库省略。 */
    postgresql_parameter_types: z.array(postgresqlParameterTypeSchema).max(1024).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const inputs = value.query_parameters;
    const outputs = value.output_parameters ?? [];
    const names = [...inputs, ...outputs].map((parameter) => parameter.name);
    if (value.postgresql_parameter_types !== undefined) {
      const types = value.postgresql_parameter_types;
      const contractTypes = {
        text: "string",
        varchar: "string",
        smallint: "integer",
        integer: "integer",
        bigint: "integer",
        numeric: "decimal",
        real: "decimal",
        "double precision": "decimal",
        boolean: "boolean",
        date: "date",
        timestamp: "datetime",
        bytea: "buffer",
      };
      if (
        types.length !== inputs.length ||
        types.some((type, index) => contractTypes[type] !== inputs[index]?.data_type)
      ) {
        context.addIssue({
          code: "custom",
          message: "PostgreSQL 原生参数类型必须完整且符合参数数据类型",
        });
      }
    }
    if (
      new Set(names).size !== names.length ||
      new Set(value.columns.map((column) => column.name)).size !== value.columns.length
    ) {
      context.addIssue({ code: "custom", message: "过程参数名和输出列名必须分别唯一" });
    }
    if (
      inputs.some(
        (parameter) => parameter.allowed_ops.length !== 1 || parameter.allowed_ops[0] !== "eq",
      )
    ) {
      context.addIssue({ code: "custom", message: "过程输入参数只支持标量 eq" });
    }
    if (
      new Set(outputs.map((parameter) => parameter.position)).size !== outputs.length ||
      outputs.some((parameter) => parameter.position >= names.length)
    ) {
      context.addIssue({ code: "custom", message: "过程输出参数位置必须唯一且位于完整签名内" });
    }
  });

export { procedureDefinitionSchema, procedureOutputParameterSchema, postgresqlParameterTypeSchema };
