import type { ConnectorKind } from "../connector";
import type { ExecutableRelation } from "../executable-query";
import type { z } from "zod";
import type { dataTypeSchema } from "@ai-data/contracts";

/** SQL 参数沿用跨服务合同的类型语义，供方言转换和驱动绑定共同使用。 */
type ParameterDataType = z.infer<typeof dataTypeSchema>;

/** 每种数据库方言必须提供的 SQL 编译能力。 */
interface DatabaseDialect {
  /** 当前方言对应的连接器类型。 */
  readonly kind: Exclude<ConnectorKind, "http_api">;
  /** 引用并转义单段标识符；调用方负责名称白名单与限定名拆分。 */
  quoteIdentifier(identifier: string): string;
  /** 生成关系别名片段。 */
  relationAliasSql(alias: string): string;
  /** 将零基参数序号转换为该方言的绑定占位符。 */
  parameterPlaceholder(index: number): string;
  /** 生成携带明确日期时间语义的参数 SQL。 */
  parameterSql(placeholder: string, dataType: ParameterDataType): string;
  /** 生成健康检查 SQL。 */
  healthSql(): string;
  /** 生成目录发现 SQL。 */
  catalogSql(): string;
  /** 生成固定对象调用模板；参数名称顺序须与驱动绑定值一致。 */
  procedureSql(relation: ExecutableRelation, parameterNames: string[]): string;
  /** 查询尾部的行数限制；在 SELECT 中限制的方言返回空文本。 */
  limitSql(limit: number): string;
  /** SELECT 开头的行数限制；在尾部限制的方言返回空文本。 */
  selectLimitSql(limit: number): string;
}

/** 引用规划器提供的物理对象名；存在 Schema 时分别引用两段名称。 */
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
