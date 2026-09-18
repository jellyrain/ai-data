import { describe, expect, it, vi } from "vitest";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { context, createApiDependencies } from "../support/api-fixtures";

/** 工具的身份与运行信息来自执行器，模型只传业务条件。 */
function setup(withSkills = false) {
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
