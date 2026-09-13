import {
  apiDatasetConfigSchema,
  type ApiDatasetConfig,
  type ContractErrorCode,
  type Dataset,
} from "@ai-data/contracts";

import { ApplicationError } from "../errors/application-error";

/** 审核键是唯一性依据：Join 字段集合包含完整键时，至多命中一条非空等值记录。 */
function coversUniqueKey(fields: string[], keys: string[][]): boolean {
  const available = new Set(fields);
  return keys.some((key) => key.every((field) => available.has(field)));
}

/** 从完整目录验证已审核键；执行阶段同样校验，及时拒绝目录或配置漂移。 */
function validateUniqueKeys(
  config: ApiDatasetConfig | null,
  columns: Dataset["columns"],
  code: ContractErrorCode,
): string[][] {
  if (!config) return [];
  if (!apiDatasetConfigSchema.safeParse(config).success)
    throw new ApplicationError(code, "数据集业务配置格式无效");
  const names = new Set(columns.map((column) => column.name));
  const keys = config.unique_keys ?? [];
  if (keys.some((key) => key.some((field) => !names.has(field))))
    throw new ApplicationError(code, "唯一键引用的数据集字段不存在");
  return keys;
}

/** 关联基数中的 one 必须由对应对象的审核键证明，字段等值还要求两侧类型一致。 */
function validateRelationConfig(
  relation: ApiDatasetConfig["approved_relations"][number],
  sourceColumns: Dataset["columns"],
  targetColumns: Dataset["columns"],
  sourceKeys: string[][],
  targetKeys: string[][],
  code: ContractErrorCode,
): void {
  const source = new Map(sourceColumns.map((column) => [column.name, column.data_type]));
  const target = new Map(targetColumns.map((column) => [column.name, column.data_type]));
  const pairs = new Set<string>();
  for (const pair of relation.column_pairs) {
    const id = JSON.stringify([pair.source_column, pair.target_column]);
    if (!source.has(pair.source_column) || !target.has(pair.target_column) || pairs.has(id))
      throw new ApplicationError(code, "批准关联字段不存在或字段对重复");
    if (source.get(pair.source_column) !== target.get(pair.target_column))
      throw new ApplicationError(code, "批准关联的两侧字段类型必须一致");
    pairs.add(id);
  }
  const sourceIsOne =
    relation.cardinality === "one_to_one" || relation.cardinality === "one_to_many";
  const targetIsOne =
    relation.cardinality === "one_to_one" || relation.cardinality === "many_to_one";
  if (
    (sourceIsOne &&
      !coversUniqueKey(
        relation.column_pairs.map((pair) => pair.source_column),
        sourceKeys,
      )) ||
    (targetIsOne &&
      !coversUniqueKey(
        relation.column_pairs.map((pair) => pair.target_column),
        targetKeys,
      ))
  )
    throw new ApplicationError(code, "关联基数的一侧需要完整已审核唯一键覆盖关联字段");
}

export { coversUniqueKey, validateRelationConfig, validateUniqueKeys };
