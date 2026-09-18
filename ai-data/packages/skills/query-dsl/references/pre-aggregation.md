# 分层聚合

多张明细表参与统计时，可在各对象的 `pre_aggregate` 中先按关联键分组，再由外层聚合计算最终结果：

- `pre_aggregate.group_by` 使用本对象别名限定的原始字段。
- `pre_aggregate.select` 每项必须明确 `as`；所有分组字段以普通字段输出，其他项使用获准聚合函数。
- 外层通过 `别名.内层输出名` 引用结果，关联键须保留其原始字段来源。
- 内层不设置返回行数上限，最终 `limit` 只限制响应结果。
- 需要复合业务键去重时，可在内层按完整键分组投影，再在外层对非空键计数。
- API 根据批准关系与实际分组粒度检查是否重复计算；依据不足或统计仍可能扩行时，补齐业务依据或调整聚合层次。

执行顺序是对象过滤 → 对象内聚合 → 关联 → 根过滤 → 最终分组聚合 → 排序与返回上限。各层行权限由 API 在对象内聚合之前注入，派生字段保留原字段的权限约束。

内层计数向外层汇总使用 `sum`；平均值、比率和跨分组去重总计按已确认指标口径计算。`count(field)` 只计非空值；空输入的 `sum` 和外连接缺失的度量按工具返回的空值解释。

## 示例

假定目录已确认就诊对象以 `visit_id` 唯一，每次就诊分别关联多条费用和处方。先将两张明细表各自汇总到就诊粒度，再关联主对象，最后按科室汇总。以下对象、字段和关系 ID 仅用于展示结构，实际查询使用目录返回的值。

```json
{
  "type": "relational_query",
  "source_id": "clinical_reporting",
  "from": { "object_id": "clinical.visit", "alias": "v" },
  "joins": [
    {
      "type": "left",
      "object_id": "clinical.fee",
      "alias": "f",
      "relation_id": "visit_fee",
      "pre_aggregate": {
        "group_by": ["f.visit_id"],
        "select": [
          { "field": "f.visit_id", "as": "visit_id" },
          { "field": "f.amount", "aggregation": "sum", "as": "total_amount" }
        ]
      },
      "on": [{ "left": "v.visit_id", "op": "eq", "right": "f.visit_id" }]
    },
    {
      "type": "left",
      "object_id": "clinical.prescription",
      "alias": "p",
      "relation_id": "visit_prescription",
      "pre_aggregate": {
        "group_by": ["p.visit_id"],
        "select": [
          { "field": "p.visit_id", "as": "visit_id" },
          { "field": "p.prescription_id", "aggregation": "count", "as": "prescription_count" }
        ]
      },
      "on": [{ "left": "v.visit_id", "op": "eq", "right": "p.visit_id" }]
    }
  ],
  "select": [
    { "field": "v.department_name", "as": "department_name" },
    { "field": "v.visit_id", "aggregation": "count", "as": "visit_count" },
    { "field": "f.total_amount", "aggregation": "sum", "as": "fee_amount" },
    { "field": "p.prescription_count", "aggregation": "sum", "as": "prescription_count" }
  ],
  "group_by": ["v.department_name"],
  "order_by": [{ "field": "visit_count", "direction": "desc" }],
  "limit": 100
}
```
