import { datasetColumnSchema, type DatasetColumn } from "@ai-data/contracts";

/** 对比签名审核的输出与本地固定定义；字段说明和排列顺序不影响授权集合。 */
function assertFixedOutput(expected: DatasetColumn[] | undefined, actual: DatasetColumn[]): void {
  if (
    !expected?.length ||
    actual.length !== expected.length ||
    new Set(actual.map((column) => column.name)).size !== actual.length ||
    new Set(expected.map((column) => column.name)).size !== expected.length
  ) {
    throw new Error("固定输出定义缺失或列集合已变化");
  }
  for (const column of expected) {
    datasetColumnSchema.parse(column);
    const local = actual.find((candidate) => candidate.name === column.name);
    if (!local || local.data_type !== column.data_type || local.nullable !== column.nullable) {
      throw new Error("固定输出定义已变化，请重新读取目录并授权");
    }
  }
}

export { assertFixedOutput };
