# 关系查询

用于 `table` 和 `view`。必须提供 `source_id`、`from` 和非空 `select`。可使用 `joins`、`filters`、`group_by`、`order_by`、`limit`。

- `from.object_id` 和 `joins[].object_id` 使用 API 目录中的逻辑对象 ID。
- 为每个关系使用简短且唯一的别名；字段引用统一为 `别名.字段名`。
- `from.filters` 和 `joins[].filters` 表达该对象在关联前执行的业务筛选，只引用自身别名；根 `filters` 在关联完成后执行。按需要保留主记录的语义选择条件位置。
- Join 只使用 API 已批准的关系，且每个 `on` 项都是字段等值比较。
- 批准关系提供 `relation_id` 时，可在 Join 中明确选择；`on` 仍须包含该关系完整的字段对。
- 聚合字段使用 `aggregation`，聚合结果和同一粒度的维度字段要设置稳定的 `as`。
- 需要汇总时，所有非聚合选择字段必须放入 `group_by`。
- 结果按业务需要排序；明细和探索查询设置适当的 `limit`，不超过 5000。

## 示例

```json
{
  "type": "relational_query",
  "source_id": "clinical_reporting",
  "from": { "object_id": "clinical.visit", "alias": "v" },
  "select": [
    { "field": "v.department_name", "as": "department_name" },
    { "field": "v.visit_id", "aggregation": "count", "as": "visit_count" }
  ],
  "filters": {
    "logic": "and",
    "items": [
      {
        "field": "v.visit_date",
        "op": "between",
        "data_type": "date",
        "value": ["2026-08-01", "2026-08-31"]
      }
    ]
  },
  "group_by": ["v.department_name"],
  "order_by": [{ "field": "visit_count", "direction": "desc" }],
  "limit": 100
}
```
