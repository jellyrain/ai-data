import { describe, expect, it, vi } from "vitest";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { context, createApiDependencies } from "../support/api-fixtures";

/** 工具的身份与运行信息来自执行器，模型只传业务条件。 */
function setup(
  withSkills = false,
  allowedNames?: string[],
  memory?: ConstructorParameters<typeof AnalysisTools>[0]["memory"],
) {
  const api = createApiDependencies();
  const runs = {
    assertCurrent: vi.fn(async () => {}),
    recordTool: vi.fn(async () => {}),
    query: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      evidence_id: "e",
      result: { columns: [], rows: [], row_count: 0, truncated: false },
    })),
    clarify: vi.fn(async () => ({})),
  };
  const skills = {
    readReference: vi.fn(() => ({
      skill_name: "query-dsl",
      relative_path: "references/query.md",
      content: "查询说明",
    })),
  };
  const service = new AnalysisTools({
    allowedNames,
    memory,
    ...(withSkills ? { skills } : {}),
    listSourceIds: async () => ["visible", "hidden"],
    runs,
    catalog: api.catalog.service,
    metrics: { ...api.analysis.metrics, query: vi.fn() },
    reports: api.analysis.reports,
    refreshContext: api.auth.refreshContext,
  } as unknown as ConstructorParameters<typeof AnalysisTools>[0]);
  const lease = { owner: "worker", epoch: 1, expires_at: "2026-09-14 23:00:00" };
  return { api, runs, service, lease, skills };
}

describe("运行绑定的查询工具", () => {
  const queryInput = {
    query: {
      type: "relational_query",
      source_id: "s",
      from: { object_id: "payment", alias: "p" },
      select: [{ field: "p.amount" }],
    },
  };
  it("查询执行明细记录对象和行数，执行 SQL 保存在证据而不扩大模型结果", async () => {
    const h = setup();
    const sql = { dialect: "sqlserver", sql: "SELECT [amount] FROM [payment]", parameters: [] };
    h.runs.query.mockResolvedValue({
      evidence_id: "e",
      result: {
        columns: [{ name: "amount", data_type: "integer" }],
        rows: [{ amount: 7 }],
        row_count: 1,
        truncated: false,
        execution_sql: sql,
      },
    });
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "query_dataset",
      queryInput,
      "query",
    );
    expect(result).toMatchObject({ success: true, output: { row_count: 1, evidence_id: "e" } });
    expect(result.output).not.toHaveProperty("execution_sql");
    expect(h.runs.recordTool).toHaveBeenLastCalledWith(
      context,
      "run",
      h.lease,
      expect.objectContaining({
        input_summary: expect.stringContaining("payment"),
        output_summary: expect.stringContaining('"row_count": 1'),
        duration_ms: expect.any(Number),
        status: "completed",
      }),
    );
  });
  it("启用定义读取后只预加载简短入口，按需读取完整定义且保持旧 Agent 参数", async () => {
    const h = setup(false, ["get_tool_schema", "query_dataset"]);
    const definitions = h.service.definitions();
    expect(definitions.map((item) => item.name)).toEqual(
      expect.arrayContaining(["get_tool_schema", "query_dataset"]),
    );
    const entry = definitions.find((item) => item.name === "query_dataset")!;
    expect(entry.inputSchema).toMatchObject({ properties: { arguments_json: { type: "string" } } });
    expect(JSON.stringify(entry.inputSchema)).not.toContain("relational_query");
    const detail = await h.service.execute(
      context,
      "run",
      h.lease,
      "get_tool_schema",
      { tool_name: "query_dataset" },
      "schema",
    );
    expect(detail).toMatchObject({ success: true, output: { name: "query_dataset" } });
    expect(JSON.stringify(detail.output)).toContain("relational_query");
    expect(JSON.stringify(setup(false, ["query_dataset"]).service.definitions())).toContain(
      "relational_query",
    );
    expect(
      setup()
        .service.definitions()
        .some((item) => item.name === "get_tool_schema"),
    ).toBe(false);
  });
  it("定义读取拒绝未授权、不存在和未装配工具", async () => {
    const h = setup(false, ["get_tool_schema", "query_dataset", "save_report_definition"]);
    for (const name of ["list_sources", "missing", "save_report_definition"]) {
      expect(
        await h.service.execute(
          context,
          "run",
          h.lease,
          "get_tool_schema",
          { tool_name: name },
          name,
        ),
      ).toMatchObject({ success: false, output: { code: "UNAUTHORIZED" } });
    }
  });
  it("JSON 参数复用原业务合同、幂等键和证据链", async () => {
    const h = setup(false, ["get_tool_schema", "query_dataset"]);
    for (const arguments_json of [
      JSON.stringify(queryInput),
      JSON.stringify(queryInput, null, 2),
    ]) {
      expect(
        await h.service.execute(
          context,
          "run",
          h.lease,
          "query_dataset",
          { arguments_json },
          "query" + arguments_json.length,
        ),
      ).toMatchObject({ success: true, output: { evidence_id: "e" } });
    }
    expect(h.runs.query).toHaveBeenCalledTimes(2);
    expect(h.runs.query.mock.calls[0]![3]).toBe(h.runs.query.mock.calls[1]![3]);
  });
  it("无效 JSON、非对象、未知字段和超字节上限在业务执行前拒绝", async () => {
    const h = setup(false, ["get_tool_schema", "query_dataset"]);
    for (const input of [
      queryInput,
      { arguments_json: "{" },
      { arguments_json: "[]" },
      { arguments_json: "null" },
      { arguments_json: JSON.stringify({ ...queryInput, user_id: "other" }) },
      { arguments_json: JSON.stringify(queryInput), extra: true },
      { arguments_json: JSON.stringify({ text: "字".repeat(23000) }) },
    ]) {
      expect(
        await h.service.execute(context, "run", h.lease, "query_dataset", input, "invalid"),
      ).toMatchObject({ success: false, output: { code: "INVALID_INPUT" } });
    }
    expect(h.runs.query).not.toHaveBeenCalled();
  });
  it("规则超出交付容量时不能记为已读取并绕过查询前核对", async () => {
    const memory = {
      businessRules: vi.fn(async () => [
        {
          knowledge_id: "large",
          version: 1,
          content: { type: "business_rule", body: "字".repeat(23000) },
          scope: { source_id: "s" },
        },
      ]),
      recordKnowledge: vi.fn(),
      capture: vi.fn(),
    };
    const h = setup(
      false,
      undefined,
      memory as unknown as ConstructorParameters<typeof AnalysisTools>[0]["memory"],
    );
    for (const call of ["first", "retry"])
      expect(
        await h.service.execute(context, "run", h.lease, "query_dataset", queryInput, call),
      ).toMatchObject({ success: false, output: { code: "QUERY_LIMIT_EXCEEDED" } });
    expect(h.runs.query).not.toHaveBeenCalled();
    expect(memory.recordKnowledge).not.toHaveBeenCalled();
  });
  it("发现工具只返回摘要，字段留给详情读取", async () => {
    const h = setup();
    h.api.catalog.service.listAuthorized.mockResolvedValue([
      {
        dataset: {
          source_id: "s",
          object_id: "payment",
          name: "支付",
          kind: "table",
          columns: [{ name: "paid_at" }],
          query_parameters: [],
        },
      },
    ] as never);
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "list_datasets",
      { source_id: "s" },
      "list",
    );
    expect(result).toMatchObject({
      success: true,
      output: { items: [{ object_id: "payment", kind: "table" }] },
    });
    expect(JSON.stringify(result.output)).not.toContain("paid_at");
  });
  it("首次直接查询先交付适用规则，读取后可执行，新版本规则需要重新读取", async () => {
    let version = 1;
    const memory = {
      businessRules: vi.fn(async () => [
        {
          knowledge_id: "rule",
          version,
          content: { type: "business_rule", title: "支付规则", body: "按支付时间" },
          scope: { source_id: "s" },
        },
      ]),
      recordKnowledge: vi.fn(async () => {}),
      capture: vi.fn(async () => {}),
    };
    const h = setup(
      false,
      undefined,
      memory as unknown as ConstructorParameters<typeof AnalysisTools>[0]["memory"],
    );
    const input = {
      query: {
        type: "relational_query",
        source_id: "s",
        from: { object_id: "payment", alias: "p" },
        select: [{ field: "p.amount" }],
      },
    };
    expect(
      await h.service.execute(context, "run", h.lease, "query_dataset", input, "first"),
    ).toMatchObject({ success: true, output: { status: "rules_required" } });
    expect(h.runs.query).not.toHaveBeenCalled();
    expect(memory.recordKnowledge).toHaveBeenCalledOnce();
    expect(
      await h.service.execute(context, "run", h.lease, "query_dataset", input, "confirmed"),
    ).toMatchObject({ success: true, output: { evidence_id: "e" } });
    expect(h.runs.query).toHaveBeenCalledOnce();
    version = 2;
    expect(
      await h.service.execute(context, "run", h.lease, "query_dataset", input, "changed"),
    ).toMatchObject({ output: { status: "rules_required" } });
    expect(h.runs.query).toHaveBeenCalledOnce();
  });
  it("Agent 工具选择同时限制发现和执行，未选工具记录拒绝且不访问业务服务", async () => {
    const h = setup(true, ["list_sources"]);
    expect(h.service.definitions().map((tool) => tool.name)).toEqual(["list_sources"]);
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "read_skill_reference",
      { skill_name: "query-dsl", relative_path: "SKILL.md" },
      "denied",
    );
    expect(result).toMatchObject({ success: false, output: { code: "UNAUTHORIZED" } });
    expect(h.skills.readReference).not.toHaveBeenCalled();
    expect(h.runs.recordTool).toHaveBeenLastCalledWith(
      context,
      "run",
      h.lease,
      expect.objectContaining({ status: "failed", error_code: "UNAUTHORIZED" }),
    );
    expect(setup(true, []).service.definitions()).toEqual([]);
  });
  it("已加载 Skill 时注册读取函数，读取前后复核身份、租约并记录审计", async () => {
    const h = setup(true);
    expect(h.service.definitions().some((tool) => tool.name === "read_skill_reference")).toBe(true);
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "read_skill_reference",
      {
        skill_name: "query-dsl",
        relative_path: "references/query.md",
      },
      "reference",
    );
    expect(result).toMatchObject({ success: true, output: { content: "查询说明" } });
    expect(h.skills.readReference).toHaveBeenCalledWith("query-dsl", "references/query.md");
    expect(h.api.auth.refreshContext).toHaveBeenCalledTimes(2);
    expect(h.runs.assertCurrent).toHaveBeenCalledTimes(2);
    expect(h.runs.recordTool).toHaveBeenLastCalledWith(
      context,
      "run",
      h.lease,
      expect.objectContaining({ tool_name: "read_skill_reference", status: "completed" }),
    );
  });
  it("未加载 Skill 时不开放读取函数，租约失效时不读取文档", async () => {
    expect(
      setup()
        .service.definitions()
        .some((tool) => tool.name === "read_skill_reference"),
    ).toBe(false);
    const h = setup(true);
    h.runs.assertCurrent.mockRejectedValue(new Error("租约失效"));
    await expect(
      h.service.execute(
        context,
        "run",
        h.lease,
        "read_skill_reference",
        {
          skill_name: "query-dsl",
          relative_path: "references/query.md",
        },
        "reference",
      ),
    ).rejects.toThrow("租约失效");
    expect(h.skills.readReference).not.toHaveBeenCalled();
  });
  it("大字符串上限作为模型说明发布，实际调用仍拒绝超过合同的参数", async () => {
    const h = setup();
    const schema = h.service.definitions().find((item) => item.name === "request_clarification")!
      .inputSchema as { properties: { question: { maxLength?: number; description: string } } };
    expect(schema.properties.question.maxLength).toBeUndefined();
    expect(schema.properties.question.description).toContain("8000");
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "request_clarification",
      {
        question: "问".repeat(8001),
        options: [{ id: "visit", label: "就诊时间" }],
        allow_custom_input: false,
      },
      "oversized",
    );
    expect(result.success).toBe(false);
    expect(h.runs.clarify).not.toHaveBeenCalled();
  });
  it("数据源发现只返回至少有一个授权对象的数据源", async () => {
    const h = setup();
    h.api.catalog.service.listAuthorized.mockImplementation(async (_context, sourceId) =>
      sourceId === "visible" ? ([{ dataset: { object_id: "visits" } }] as never) : [],
    );
    expect(
      await h.service.execute(context, "run", h.lease, "list_sources", {}, "sources"),
    ).toMatchObject({ success: true, output: { items: [{ source_id: "visible" }] } });
  });
  it("模型不能覆盖当前用户、角色或运行标识", async () => {
    const h = setup();
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "list_datasets",
      { source_id: "s", user_id: "other" },
      "call",
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatchObject({
      code: "INVALID_INPUT",
      issues: [expect.objectContaining({ message: expect.stringContaining("user_id") })],
    });
    expect(h.api.catalog.service.listAuthorized).not.toHaveBeenCalled();
  });
  it("工具每次重读权限并只返回授权目录的当前页和游标", async () => {
    const h = setup();
    h.api.catalog.service.listAuthorized.mockResolvedValue([
      { dataset: { object_id: "a" } },
      { dataset: { object_id: "b" } },
    ] as never);
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "list_datasets",
      { source_id: "s", limit: 1 },
      "call",
    );
    expect(result).toMatchObject({
      success: true,
      output: { items: [{ object_id: "a" }], next_cursor: "1" },
    });
    expect(h.api.auth.refreshContext).toHaveBeenCalledWith(context);
    expect(h.runs.recordTool).toHaveBeenCalledTimes(2);
  });
  it("同一查询在恢复后使用稳定证据标识，工具返回后运行仍交由执行器推进", async () => {
    const h = setup();
    const input = {
      query: {
        type: "relational_query",
        source_id: "s",
        from: { object_id: "visits", alias: "v" },
        select: [{ field: "v.id", as: "id" }],
      },
    };
    await h.service.execute(context, "run", h.lease, "query_dataset", input, "first");
    await h.service.execute(context, "run", h.lease, "query_dataset", input, "after-restart");
    expect(h.runs.query.mock.calls[0]?.[3]).toBe(h.runs.query.mock.calls[1]?.[3]);
  });
  it("澄清先持久化到原运行，再要求 Harness 暂停", async () => {
    const h = setup();
    const result = await h.service.execute(
      context,
      "run",
      h.lease,
      "request_clarification",
      {
        question: "按哪种时间统计？",
        options: [{ id: "visit", label: "就诊时间" }],
        allow_custom_input: false,
      },
      "clarify",
    );
    expect(result).toMatchObject({ success: true, stop: true });
    expect(h.runs.clarify).toHaveBeenCalledWith(
      context,
      "run",
      h.lease,
      expect.objectContaining({ clarification_id: expect.any(String) }),
      expect.objectContaining({ status: "completed" }),
    );
  });
  it("租约失效时不调用目录或查询能力", async () => {
    const h = setup();
    h.runs.assertCurrent.mockRejectedValue(new Error("租约失效"));
    await expect(
      h.service.execute(context, "run", h.lease, "list_datasets", { source_id: "s" }, "call"),
    ).rejects.toThrow("租约失效");
    expect(h.api.catalog.service.listAuthorized).not.toHaveBeenCalled();
  });
});
