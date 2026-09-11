import type { ConnectorKind } from "../connector";
import type { ExecutableRelation } from "../executable-query";
import type { z } from "zod";
import type { dataTypeSchema } from "@ai-data/contracts";

type ParameterDataType = z.infer<typeof dataTypeSchema>;

/** 每种数据库方言必须提供的 SQL 编译能力。 */
interface DatabaseDialect {
  /** 当前方言对应的连接器类型。 */
  readonly kind: Exclude<ConnectorKind, "http_api">;
  /** 生成安全的标识符或字段引用。 */
  quoteIdentifier(identifier: string): string;
  /** 生成关系别名片段。 */
  relationAliasSql(alias: string): string;
  /** 生成第 n 个参数占位符。 */
  parameterPlaceholder(index: number): string;
  /** 生成携带明确日期时间语义的参数 SQL。 */
  parameterSql(placeholder: string, dataType: ParameterDataType): string;
  /** 生成健康检查 SQL。 */
  healthSql(): string;
  /** 生成目录发现 SQL。 */
  catalogSql(): string;
  /** 生成固定对象参数调用 SQL。 */
  procedureSql(relation: ExecutableRelation, parameterNames: string[]): string;
  /** 生成查询尾部的行数限制片段。 */
  limitSql(limit: number): string;
  /** 生成 SELECT 开头的行数限制片段。 */
  selectLimitSql(limit: number): string;
}

/** 根据物理关系拼接受控 schema.object 名称。 */
function renderPhysicalName(
  relation: ExecutableRelation,
  quoteIdentifier: (identifier: string) => string,
): string {
  return relation.native_schema_name
    ? `${quoteIdentifier(relation.native_schema_name)}.${quoteIdentifier(relation.native_object_name)}`
    : quoteIdentifier(relation.native_object_name);
}

export { renderPhysicalName };
export type { DatabaseDialect, ParameterDataType };
