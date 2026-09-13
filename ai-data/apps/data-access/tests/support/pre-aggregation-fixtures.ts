/** 各对象独立过滤，费用与处方先按就诊汇总，再与主记录关联并进行最终统计。 */
function preAggregationQuery() {
  return {
    type: "relational_query" as const,
    source_id: "clinical",
    timeout_ms: 1000,
    row_limit: 100,
    from: {
      object_id: "visit",
      native_object_name: "visit",
      alias: "v",
      filters: {
        logic: "and" as const,
        items: [{ field: "v.org", op: "eq" as const, data_type: "string" as const, value: "A" }],
      },
    },
    joins: [
      {
        type: "left" as const,
        relation: {
          object_id: "fee",
          native_object_name: "fee",
          alias: "f",
          filters: {
            logic: "and" as const,
            items: [
              { field: "f.org", op: "eq" as const, data_type: "string" as const, value: "A" },
            ],
          },
          pre_aggregate: {
            group_by: ["f.visit_id"],
            select: [
              { field: "f.visit_id", as: "visit_key" },
              { field: "f.amount", aggregation: "sum" as const, as: "fee_sum" },
            ],
          },
        },
        on: [{ left: "v.id", op: "eq" as const, right: "f.visit_key" }],
      },
      {
        type: "left" as const,
        relation: {
          object_id: "prescription",
          native_object_name: "prescription",
          alias: "r",
          filters: {
            logic: "and" as const,
            items: [
              { field: "r.org", op: "eq" as const, data_type: "string" as const, value: "A" },
            ],
          },
          pre_aggregate: {
            group_by: ["r.visit_id"],
            select: [
              { field: "r.visit_id", as: "visit_key" },
              { field: "r.id", aggregation: "count" as const, as: "prescription_count" },
            ],
          },
        },
        on: [{ left: "v.id", op: "eq" as const, right: "r.visit_key" }],
      },
    ],
    filters: { logic: "and" as const, items: [] },
    select: [
      { field: "v.id", aggregation: "count" as const, as: "visits" },
      { field: "f.fee_sum", aggregation: "sum" as const, as: "fees" },
      { field: "r.prescription_count", aggregation: "sum" as const, as: "prescriptions" },
    ],
    group_by: [],
    order_by: [],
  };
}

/** 两条相同金额费用和多张处方会使直接明细关联产生乘积；第三次就诊没有明细。 */
const preAggregationDataSql = `
  CREATE TABLE visit(id INTEGER, org TEXT);
  CREATE TABLE fee(id INTEGER, visit_id INTEGER, amount INTEGER, org TEXT);
  CREATE TABLE prescription(id INTEGER, visit_id INTEGER, org TEXT);
  INSERT INTO visit VALUES(1,'A'),(2,'A'),(3,'A'),(4,'B');
  INSERT INTO fee VALUES(11,1,100,'A'),(12,1,100,'A'),(21,2,40,'A'),(41,4,900,'B');
  INSERT INTO prescription VALUES(11,1,'A'),(12,1,'A'),(13,1,'A'),(21,2,'A'),(22,2,'A'),(41,4,'B');
`;

export { preAggregationDataSql, preAggregationQuery };
