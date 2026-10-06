import type { CurrentPolicyState } from "@ai-data/contracts";
import { parseManagementJson } from "../../data-management/stores/object-selection";
import type { PolicyDraft } from "./policy-draft-types";
/** 新规则默认显式允许，实际生效仍需要管理员提交。 */
function policyDraft(
  current: CurrentPolicyState,
  object: string,
  column: string,
  kind: PolicyDraft["kind"],
): PolicyDraft {
  const objects = current.snapshot.object_permissions.find((item) => item.object_id === object),
    columns = current.snapshot.column_permissions.find(
      (item) => item.object_id === object && item.column === column,
    ),
    row = current.snapshot.row_policies.find((item) => item.object_id === object);
  return {
    kind,
    effect: (kind === "column" ? columns : objects)?.effect ?? "allow",
    column,
    allOperations: columns?.operations === undefined,
    operations: columns?.operations ?? ["select", "filter", "group", "sort", "join"],
    rowField: row?.condition.field ?? column,
    rowOp: row?.condition.op ?? "eq",
    valueSource: row?.condition.value_from ? "context" : "literal",
    literal: JSON.stringify(row?.condition.value ?? ""),
    context: row?.condition.value_from ?? "permission_context.department_ids",
  };
}
function policyInput(
  draft: PolicyDraft,
  source: string,
  role: string,
  object: string,
  version: number,
) {
  const common = { source_id: source, role_id: role, object_id: object, expected_version: version };
  if (draft.kind === "object") return { ...common, effect: draft.effect };
  if (draft.kind === "column")
    return {
      ...common,
      column: draft.column,
      effect: draft.effect,
      ...(draft.effect === "allow" && !draft.allOperations ? { operations: draft.operations } : {}),
    };
  return {
    ...common,
    effect: "allow",
    condition: {
      field: draft.rowField,
      op: draft.rowOp,
      ...(["is_null", "not_null"].includes(draft.rowOp)
        ? {}
        : draft.valueSource === "context"
          ? { value_from: draft.context }
          : { value: parseManagementJson(draft.literal, "固定行范围值") }),
    },
  };
}
export { policyDraft, policyInput };
