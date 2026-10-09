import {
  queryCapabilitiesSchema,
  procedureDefinitionSchema,
  type ManagedSourceObject,
  type QueryCapabilities,
} from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";
import type { ObjectSelection } from "./object-selection-types";
/** 物理映射由完整白名单取得，逻辑别名继续作为 API 的稳定主键。 */
function objectSelection(value: ManagedSourceObject): ObjectSelection {
  return {
    object_id: value.object_id,
    discovered_object_id: [value.object_kind, value.native_schema_name, value.native_object_name]
      .filter((part) => part !== undefined)
      .join("."),
    is_discoverable: value.is_discoverable,
    is_queryable: value.is_queryable,
    query_capabilities: value.query_capabilities,
    ...(value.procedure_definition ? { procedure_definition: value.procedure_definition } : {}),
  };
}
function parseManagementJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ApiError(`${label} 不是有效 JSON`, 400, "INVALID_INPUT");
  }
}
function objectEdits(
  value: ObjectSelection,
  capabilities: QueryCapabilities | undefined,
  procedure: string,
): ObjectSelection {
  return {
    ...value,
    query_capabilities: queryCapabilitiesSchema.parse(capabilities ?? {}),
    procedure_definition: procedure.trim()
      ? procedureDefinitionSchema.parse(parseManagementJson(procedure, "过程定义"))
      : null,
  };
}
export { objectSelection, objectEdits, parseManagementJson };
