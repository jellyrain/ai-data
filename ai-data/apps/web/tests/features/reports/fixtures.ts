import {
  reportDefinitionVersionSchema,
  reportExecutionSchema,
  queryEvidenceSchema,
  queryDslSchema,
} from "@ai-data/contracts";
const definition = reportDefinitionVersionSchema.parse({
  report_id: "report",
  version: 1,
  organization_id: "org",
  user_id: "user",
  created_at: "2026-09-27 08:00:00",
  definition: {
    title: "门诊业务月报",
    parameters: [{ name: "min", label: "最少人次", data_type: "integer", default_value: 0 }],
    queries: [
      {
        query_id: "visits",
        query: {
          type: "relational_query",
          source_id: "demo",
          from: { object_id: "visits", alias: "v" },
          select: [{ field: "v.department" }, { field: "v.count" }],
        },
      },
    ],
    presentation: [
      {
        section_id: "main",
        title: "科室工作量",
        blocks: [
          { block_id: "table", type: "table", title: "就诊统计", query_ids: ["visits"] },
          {
            block_id: "chart",
            type: "chart",
            title: "科室分布",
            query_ids: ["visits"],
            chart: { type: "bar", x: "department", y: "count" },
          },
        ],
      },
    ],
  },
});
const query = queryDslSchema.parse(definition.definition.queries[0]!.query);
const evidence = queryEvidenceSchema.parse({
  evidence_id: "evidence",
  tool_call_id: "tool",
  analysis_run_id: "run",
  organization_id: "org",
  user_id: "user",
  created_at: definition.created_at,
  requested_query: query,
  authorized_query: query,
  output_masks: [],
  result: {
    columns: [
      { name: "department", data_type: "string" },
      { name: "count", data_type: "integer" },
    ],
    rows: [
      { department: "内科", count: 40 },
      { department: "外科", count: 30 },
    ],
    row_count: 2,
    truncated: false,
  },
});
const execution = reportExecutionSchema.parse({
  execution_id: "execution",
  report_id: "report",
  organization_id: "org",
  user_id: "user",
  definition_version: 1,
  definition: definition.definition,
  parameters: { min: 0 },
  status: "completed",
  analysis_run_id: "run",
  lease_epoch: 1,
  deadline: "2026-09-27 08:02:00",
  created_at: definition.created_at,
  completed_at: definition.created_at,
  results: [{ query_id: "visits", evidence }],
  snapshot: {
    report_id: "report",
    version: 1,
    organization_id: "org",
    user_id: "user",
    analysis_run_id: "run",
    title: definition.definition.title,
    created_at: definition.created_at,
    definition_version: 1,
    execution_id: "execution",
    sources: [evidence],
    sections: [
      {
        section_id: "main",
        title: "科室工作量",
        blocks: [
          { block_id: "table", type: "table", title: "就诊统计", evidence_ids: ["evidence"] },
        ],
      },
    ],
  },
});
export { definition, evidence, execution };
