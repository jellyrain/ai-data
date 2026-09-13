# 关系查询的分层聚合

关系查询可以先将每张明细表汇总到关联所需的粒度，再关联并计算最终结果。API 根据字段权限、唯一键和批准关系核对每层统计；DAS 按签名后的 DSL 在数据库内执行所有层次。

## 业务配置

`apiDatasetConfig.unique_keys` 保存管理员审核的唯一键，每项是一组共同唯一的字段。`approved_relations` 可保存稳定 `relation_id` 及从当前对象到目标对象的 `cardinality`：`one_to_one`、`one_to_many`、`many_to_one`、`many_to_many`。

以下示例声明一次就诊可以关联多条费用和多条处方：

```json
{
  "source_id": "clinical",
  "object_id": "visit",
  "grain": "每行一次就诊",
  "unique_keys": [["visit_id"]],
  "approved_relations": [
    {
      "relation_id": "visit_fee",
      "target_object_id": "fee",
      "description": "本次就诊的费用明细",
      "cardinality": "one_to_many",
      "column_pairs": [{ "source_column": "visit_id", "target_column": "visit_id" }]
    },
    {
      "relation_id": "visit_prescription",
      "target_object_id": "prescription",
      "description": "本次就诊的处方明细",
      "cardinality": "one_to_many",
      "column_pairs": [{ "source_column": "visit_id", "target_column": "visit_id" }]
    }
  ]
}
```

唯一键字段必须存在，组成复合键的字段全部共同生效。关联声称某一侧为 `one` 时，该侧的关联字段必须覆盖一个已审核唯一键。目标侧为 `one` 时，应先保存目标对象的唯一键配置。API 在保存配置和执行查询时核对依据；唯一性是否符合实际业务数据，由管理员在数据源验收。

旧配置仍可用于已有明细查询。开放关联统计前应补齐相应基数和键；缺少可靠依据或可能重复计算度量时，API 会拒绝该统计请求。

## 查询结构

`from` 和每个 `joins[]` 可添加 `pre_aggregate`。其中 `group_by` 决定该对象的输出粒度，`select` 明确输出列及其 `as` 名称。内层字段使用对象自己的别名，外层字段使用同一别名与内层输出名称。

```json
{
  "type": "relational_query",
  "source_id": "clinical",
  "from": { "object_id": "visit", "alias": "v" },
  "joins": [
    {
      "type": "left",
      "object_id": "fee",
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
      "object_id": "prescription",
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
    { "field": "v.department", "as": "department" },
    { "field": "v.visit_id", "aggregation": "count", "as": "visit_count" },
    { "field": "f.total_amount", "aggregation": "sum", "as": "fee_amount" },
    { "field": "p.prescription_count", "aggregation": "sum", "as": "prescription_count" }
  ],
  "group_by": ["v.department"],
  "order_by": [{ "field": "visit_count", "direction": "desc" }],
  "limit": 100
}
```

执行顺序是每个对象的业务及权限过滤 → 对象内聚合 → 关联 → 根过滤 → 最终分组聚合 → 排序与返回上限。内层聚合处理完整的获准输入，最终上限只影响响应结果；超过返回上限时继续使用 `truncated` 标记。

对于同一科室三次就诊，第一笔就诊有两条各 10 元费用和两条处方，第二笔有一条 30 元费用和一条处方，第三笔没有明细，上述统计应得到：就诊数 3、费用 50、处方数 3。两个相同金额的真实费用都会参与汇总。

## 字段、粒度与权限

- 每个内层分组字段都要以普通字段投影输出，所有内层普通选择字段都必须属于该层分组。输出名必须唯一；外层只能引用这些已定义的输出。
- 分组键形成该层结果的唯一键。关联条件仍须完整匹配批准关系中的原始字段对；API 通过字段来源核对内层重命名，聚合度量不能作为原始关联键。
- 可以只做分组投影来按复合业务键去重，再在外层计数。例如先按 `organization_id + visit_id` 分组，投影两列，然后对非空的就诊键计数。
- API 跟踪关联链中每个对象是否可能扩行。`sum`、`count`、`avg` 需要确保各输入值按请求粒度参与一次；`count_distinct`、`min`、`max` 按各自函数语义检查。实际分组后的唯一性参与本次关联判断。
- 每层输入字段均受列权限和操作能力控制，行权限在对象内聚合之前执行。派生输出保留字段来源及原有过滤、分组、排序限制，重命名不能绕过列权限或脱敏；过滤值按当前层的实际类型校验。
- 最终分组查询中的普通选择字段必须属于根 `group_by`。排序可以引用最终输出别名；按对象字段排序时须满足该层分组约束。

统计口径仍需明确。`count(field)` 只计非空值，空输入的 `sum` 与外连接缺失的度量按 SQL 返回空值；分组平均值、比率和跨分组去重总计应依据指标口径重新计算。当前结构支持每对象预聚合加最终聚合，指标版本、总计公式和报告证据由后续业务模型管理。

SQL Server 的 `avg` 使用 `FLOAT(53)` 计算，保留整数输入平均值的小数部分，返回值遵循当前有限 JavaScript `number` 合同，精度为双精度近似值。原生 `AVG(INT)` 会返回整数，类型依据见 [SQL Server AVG 文档](https://learn.microsoft.com/en-us/sql/t-sql/functions/avg-transact-sql?view=sql-server-ver17)。

## 配置与验证

这些字段保存在 API 现有 `config_json` 中，无需新增元数据库列。升级时协调 API 与 DAS 版本，再发布键和关系配置；旧版服务会拒绝新增 DSL 字段。

验收应覆盖多明细关联、复合业务键、同对象多别名、不同角色范围、无匹配的外连接记录、空输入和结果截断。自动化验证使用内存 SQL 执行及四种方言编译；各目标数据库的实际类型、权限账号与性能仍需专用环境验收。
