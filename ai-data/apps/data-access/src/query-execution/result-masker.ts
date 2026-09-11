import type { MaskingRule, QueryAccessContext } from "@ai-data/contracts";

import type { ConnectorExecutionResult } from "../connectors/connector-result";

/** 将 API 已签名的结果列脱敏策略应用到连接器结果。 */
function applyOutputMasks(
  result: ConnectorExecutionResult,
  access: Pick<QueryAccessContext, "output_masks">,
): ConnectorExecutionResult {
  const rules = new Map(access.output_masks.map((mask) => [mask.result_column, mask.rule]));
  if (rules.size === 0) return result;

  const columnTypes = new Map(result.columns.map((column) => [column.name, column.data_type]));
  return {
    ...result,
    rows: result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => {
          const rule = rules.get(name);
          return [
            name,
            rule === undefined || columnTypes.get(name) !== "string"
              ? value
              : applyMask(value, rule),
          ];
        }),
      ),
    ),
  };
}

/** 对一个字符串结果单元格执行固定部分脱敏。 */
function applyMask(value: unknown, rule: MaskingRule): unknown {
  if (value === null || rule.type === "none" || typeof value !== "string") return value;
  const visibleLength = rule.prefix_length + rule.suffix_length;
  if (value.length <= visibleLength) return rule.mask_character.repeat(value.length);
  return `${value.slice(0, rule.prefix_length)}${rule.mask_character.repeat(value.length - visibleLength)}${value.slice(-rule.suffix_length)}`;
}

export { applyOutputMasks };
