/* 虚构的原型数据；字段参照共享合同，用于页面和交互演示。 */
globalThis.AIBIDemoData = {
  departments: [
    { department: "内科", july: 3060, august: 3480 },
    { department: "外科", july: 2700, august: 2860 },
    { department: "儿科", july: 2040, august: 2240 },
    { department: "妇科", july: 1720, august: 1800 },
    { department: "眼科", july: 1160, august: 1220 },
    { department: "其他科室", july: 880, august: 880 },
  ],
  agent: {
    agent_id: "demo-operations",
    version: 2,
    name: "运营分析助手",
    description: "核对业务口径，分析趋势与科室差异，并提供可追溯的查询证据。",
    instructions: "优先确认指标与时间范围；结论引用本次执行的数据证据。",
    model_id: "demo-analysis-model",
    model_version: 3,
    tool_names: ["read_skill_reference", "search_catalog", "query_metric"],
    skill_names: ["query-analysis", "query-dsl"],
    limits: {
      timeout_ms: 180000,
      max_tool_calls: 30,
      max_context_bytes: 262144,
    },
  },
  model: {
    model_id: "demo-analysis-model",
    version: 3,
    name: "业务分析模型",
    protocol: "responses",
    base_url: "https://model.example.invalid/v1",
    model: "demo-analysis",
    context_window: 131072,
    enabled: true,
    has_api_key: true,
    header_names: [],
  },
  definition: {
    title: "门诊量月度分析",
    parameters: [
      {
        name: "start_date",
        label: "开始日期",
        data_type: "date",
        required: true,
        default_value: "2026-08-01",
      },
      {
        name: "end_date",
        label: "结束日期",
        data_type: "date",
        required: true,
        default_value: "2026-08-31",
      },
    ],
    queries: [
      {
        query_id: "department_visits",
        query: {
          type: "metric_query",
          metric_id: "demo-outpatient-visits",
          version: 2,
          output: "grouped",
          start: "2026-08-01",
          end: "2026-08-31",
          dimensions: ["department"],
        },
        bindings: [
          {
            parameter: "start_date",
            target: { type: "metric_date", part: "start" },
          },
          {
            parameter: "end_date",
            target: { type: "metric_date", part: "end" },
          },
        ],
      },
    ],
    presentation: [
      {
        section_id: "department_overview",
        title: "科室分布",
        blocks: [
          {
            block_id: "visits_chart",
            type: "chart",
            title: "各科室门诊量",
            query_ids: ["department_visits"],
            chart: { type: "bar", x: "department", y: "visits" },
          },
          {
            block_id: "visits_table",
            type: "table",
            title: "科室明细",
            query_ids: ["department_visits"],
            columns: ["department", "visits"],
          },
        ],
      },
    ],
    block_references: [],
    editor_layout: { nodes: [{ id: "department_visits", x: 64, y: 72 }] },
  },
  clarification: {
    type: "clarification",
    conversation_id: "demo-conversation",
    analysis_run_id: "demo-run",
    sequence: 2,
    clarification_id: "demo-clarification",
    question: "这次按哪个时间口径统计门诊人次？",
    options: [
      { id: "registered", label: "按挂号时间" },
      { id: "visited", label: "按就诊时间" },
    ],
    allow_custom_input: true,
  },
};
