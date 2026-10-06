import type { ColumnPermission, RowPolicy } from "@ai-data/contracts";
/** 以单条对象、字段或行规则为提交单位，保持现有保存接口的粒度。 */
type PolicyDraft = {
  kind: "object" | "column" | "row";
  effect: "allow" | "deny";
  column: string;
  allOperations: boolean;
  operations: NonNullable<ColumnPermission["operations"]>;
  rowField: string;
  rowOp: RowPolicy["condition"]["op"];
  valueSource: "literal" | "context";
  literal: string;
  context: string;
};
export type { PolicyDraft };
