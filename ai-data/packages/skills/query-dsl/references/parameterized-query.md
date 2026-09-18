# 参数化查询

用于 `stored_procedure` 和 `api_dataset`。必须提供 `source_id`、`from` 和 `parameters`。

- 只传目录 `query_parameters` 中定义且 API 允许的参数。
- 每个参数都带 `name`、`data_type` 和 `value`。
- 返回列由数据集固定，不能填写 `select`、`joins`、`filters`、`group_by` 或 `order_by`。

## 示例

```json
{
  "type": "parameterized_query",
  "source_id": "clinical_reporting",
  "from": { "object_id": "clinical.get_visit_summary", "alias": "summary" },
  "parameters": [
    { "name": "start_date", "data_type": "date", "value": "2026-08-01" },
    { "name": "end_date", "data_type": "date", "value": "2026-08-31" }
  ],
  "limit": 100
}
```
