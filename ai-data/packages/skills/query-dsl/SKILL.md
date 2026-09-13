---
name: query-dsl
description: Build validated AI BI query DSL from API-provided datasets, fields, parameters, and approved relations. Use when turning an analysis question into a data query; do not use for free SQL or DAS administration.
---

# Query DSL

将业务问题转换为 API 工具可接收的结构化查询 DSL。DSL 只表达本次查询的业务意图；API 负责目录权限、字段能力、批准关系和权限过滤条件，随后构造发送给 DAS 的内部请求。

## 使用前的依据

只使用 API 已返回或已确认的信息：

- `source_id`、`object_id`、对象 `kind`、字段、字段 `data_type`。
- `query_capabilities`、`query_parameters`、API 已批准的关系，以及查询需要的唯一键和关联基数。
- 已确认的指标定义、时间范围、维度、筛选条件和排序要求。

目录或口径不足以唯一确定对象、字段、时间含义或关联关系时，先调用 `search_catalog`、`list_datasets`、`describe_dataset`，或提出澄清；不猜测物理表名、字段名和 Join 键。

## 查询类型

### `relational_query`

用于 `table` 和 `view`。必须提供 `source_id`、`from` 和非空 `select`。可使用 `joins`、`filters`、`group_by`、`order_by`、`limit`。

- `from.object_id` 和 `joins[].object_id` 使用 API 目录中的逻辑对象 ID。
- 为每个关系使用简短且唯一的别名；字段引用统一为 `别名.字段名`。
- `from.filters` 和 `joins[].filters` 表达该对象在关联前执行的业务筛选，只引用自身别名；根 `filters` 在关联完成后执行。按需要保留主记录的语义选择条件位置。
- Join 只使用 API 已批准的关系，且每个 `on` 项都是字段等值比较。
- 批准关系提供 `relation_id` 时，可在 Join 中明确选择；`on` 仍须包含该关系完整的字段对。
- 聚合字段使用 `aggregation`，聚合结果和同一粒度的维度字段要设置稳定的 `as`。
- 需要汇总时，所有非聚合选择字段必须放入 `group_by`。
- 结果按业务需要排序；明细和探索查询设置适当的 `limit`，不超过 5000。

多张明细表参与统计时，可在各对象的 `pre_aggregate` 中先按关联键分组，再由外层聚合计算最终结果：

- `pre_aggregate.group_by` 使用本对象别名限定的原始字段。
- `pre_aggregate.select` 每项必须明确 `as`；所有分组字段以普通字段输出，其他项使用获准聚合函数。
- 外层通过 `别名.内层输出名` 引用结果，关联键须保留其原始字段来源。
- 内层不设置返回行数上限，最终 `limit` 只限制响应结果。
- 需要复合业务键去重时，可在内层按完整键分组投影，再在外层对非空键计数。
- API 根据批准关系与实际分组粒度检查是否重复计算；依据不足或统计仍可能扩行时，补齐业务依据或调整聚合层次。

内层计数向外层汇总使用 `sum`；平均值、比率和跨分组去重总计按已确认指标口径计算。完整结构见 [分层聚合说明](../../../RELATIONAL-AGGREGATION.md)。

### `parameterized_query`

用于 `stored_procedure` 和 `api_dataset`。必须提供 `source_id`、`from` 和 `parameters`。

- 只传目录 `query_parameters` 中定义且 API 允许的参数。
- 每个参数都带 `name`、`data_type` 和 `value`。
- 返回列由数据集固定，不能填写 `select`、`joins`、`filters`、`group_by` 或 `order_by`。

## 值与类型

过滤条件和参数都必须带真实 `data_type`，只使用以下类型：

| 类型       | JSON 值               |
| ---------- | --------------------- |
| `string`   | 字符串                |
| `integer`  | 整数                  |
| `decimal`  | 数字                  |
| `boolean`  | `true` 或 `false`     |
| `date`     | `YYYY-MM-DD`          |
| `datetime` | `YYYY-MM-DD HH:mm:ss` |
| `buffer`   | Base64 字符串         |

- `eq`、`neq` 使用单个值。
- `in`、`not_in` 使用非空数组，数组元素类型一致。
- `between` 使用恰好两个同类型值，并按起始值、结束值排列。
- `is_null`、`not_null` 不得携带 `value`。
- 日期与日期时间使用合同格式，不能传 ISO UTC、数据库函数或自然语言时间。

## 输出形状

关系查询示例：

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

参数化查询示例：

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

## 边界

- 不输出 SQL、数据库方言、数据库函数、连接串、HTTP URL、JSONPath 或自由表达式。
- 不输出 `access`、`signature`、JWT、权限配置或脱敏规则；这些由 API 生成并签名。
- 行级权限由 API 根据当前用户计算，按每个对象别名合并到该对象的 `filters`，与业务筛选共同生效。
- 不跨 `source_id` Join；需要跨源分析时，由 API 分别查询并进行受控合并。
- 查询结果用于结论前，核对返回行数、列含义、时间范围、筛选条件和聚合粒度；结果与口径冲突时回到目录或澄清阶段。
