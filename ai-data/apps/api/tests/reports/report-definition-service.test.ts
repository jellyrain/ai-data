import { describe, expect, it, vi } from "vitest";
import {
  reportDefinitionSchema,
  type ReportDefinitionVersion,
  type ReusableReportBlock,
} from "@ai-data/contracts";
import { ReportDefinitionService } from "../../src/reports/report-definition-service";
import type { DefinitionRepository } from "../../src/reports/report-definition-types";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";

const definition = reportDefinitionSchema.parse({
  title: "就诊分析",
  queries: [
    {
      query_id: "visits",
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visit", alias: "v" },
        select: [{ field: "v.id" }],
      },
    },
  ],
  presentation: [
    {
      section_id: "s",
      title: "结果",
      blocks: [{ block_id: "b", type: "table", title: "就诊", query_ids: ["visits"] }],
    },
  ],
});

function setup() {
  const records = new Map<string, (ReportDefinitionVersion | ReusableReportBlock)[]>();
  const source = vi.fn(async () => []);
  const validateDefinition = vi.fn(async () => undefined);
  const listPublished = vi.fn(async (): Promise<ReportDefinitionVersion[]> => []);
  const repository: DefinitionRepository = {
    transaction: async (operation) => operation({ execute: vi.fn() }),
    find: async (kind, org, id, version) => {
      const history = records.get(`${kind}:${org}:${id}`) ?? [];
      return structuredClone(
        (version ? history.find((item) => item.version === version) : history.at(-1)) ?? null,
      );
    },
    save: async (kind, ctx, input, id, expectedVersion) => {
      const key = `${kind}:${ctx.organizationId}:${id ?? "new"}`;
      const history = records.get(key) ?? [];
      if (
        id &&
        ((!history.length && expectedVersion !== 0) ||
          (history.length && history.at(-1)!.user_id !== ctx.userId))
      )
        throw new ApplicationError("NOT_FOUND", "不存在");
      if (history.length && history.at(-1)!.version !== expectedVersion)
        throw new ApplicationError("CONFLICT", "版本冲突");
      const record = {
        ...input,
        organization_id: ctx.organizationId,
        user_id: ctx.userId,
        version: history.length + 1,
        created_at: "2026-09-21 10:00:00",
        ...(kind === "report" ? { report_id: id ?? "new" } : { block_id: id ?? "new" }),
      } as ReportDefinitionVersion | ReusableReportBlock;
      history.push(structuredClone(record));
      records.set(key, history);
      return structuredClone(record);
    },
    list: async (kind, org, after, limit) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(`${kind}:${org}:`))
        .map(([, items]) => items.at(-1)!)
        .filter((item) => ("report_id" in item ? item.report_id : item.block_id) > (after ?? ""))
        .slice(0, limit),
    versions: async (kind, org, id) => structuredClone(records.get(`${kind}:${org}:${id}`) ?? []),
    assertActiveUsers: async (_org, users) => {
      if (users.includes("inactive")) throw new ApplicationError("INVALID_INPUT", "分享账号无效");
    },
    source,
  };
  const service = new ReportDefinitionService({
    repository,
    validateDefinition,
    authorizeEvidence: vi.fn(async () => undefined),
    listPublished,
  });
  return { service, source, validateDefinition, listPublished };
}

describe("统一报表定义及二次编辑", () => {
  it("内部预留标识只在首建时接受零基准，不能覆盖已有报表", async () => {
    const h = setup();
    expect((await h.service.save(context, { definition }, "reserved", 0)).report_id).toBe(
      "reserved",
    );
    await expect(h.service.save(context, { definition }, "reserved", 0)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("组织读者只获得已生效发布版本，不能读取作者未审核新版本", async () => {
    const h = setup();
    const first = await h.service.save(context, { definition });
    await h.service.save(
      context,
      { definition: { ...definition, title: "未审核新版本" } },
      first.report_id,
      1,
    );
    h.listPublished.mockResolvedValue([first]);
    const reader = { ...context, userId: "organization-reader" };
    await expect(h.service.get(reader, first.report_id)).resolves.toMatchObject({ version: 1 });
    await expect(h.service.get(reader, first.report_id, 2)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("保存与追加参数只验证定义，保持同一报表的连续版本", async () => {
    const h = setup();
    const first = await h.service.save(context, { definition });
    const next = structuredClone(definition);
    next.parameters.push({
      name: "department",
      label: "科室",
      data_type: "string",
      required: false,
    });
    next.queries[0].bindings.push({
      parameter: "department",
      target: { type: "filter", scope: "query", field: "v.department", op: "eq" },
    });
    const second = await h.service.save(context, { definition: next }, first.report_id, 1);
    expect(second.version).toBe(2);
    expect((await h.service.get(context, first.report_id, 1)).definition.parameters).toEqual([]);
    expect(h.validateDefinition).toHaveBeenCalledTimes(3);
    await expect(h.service.save(context, { definition }, first.report_id, 1)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  });
  it("当前分享控制历史定义访问，分享账号须在同一组织处于活跃状态", async () => {
    const h = setup();
    const report = await h.service.save(context, { definition, shared_with: ["reader"] });
    const reader = { ...context, userId: "reader" };
    await expect(h.service.get(reader, report.report_id)).resolves.toMatchObject({ version: 1 });
    await expect(h.service.save(reader, { definition }, report.report_id, 1)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      h.service.share(context, report.report_id, {
        expected_version: 1,
        shared_with: ["inactive"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await h.service.share(context, report.report_id, { expected_version: 1, shared_with: [] });
    await expect(h.service.get(reader, report.report_id, 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("未完成来源拒绝保存，块升级须包含全部参数映射", async () => {
    const h = setup();
    h.source.mockRejectedValueOnce(new ApplicationError("CONFLICT", "运行尚未完成"));
    await expect(
      h.service.save(context, { definition, source_analysis_run_id: "running" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const blockDefinition = structuredClone(definition);
    blockDefinition.parameters.push({
      name: "department",
      label: "科室",
      data_type: "string",
      required: true,
    });
    blockDefinition.queries[0].bindings.push({
      parameter: "department",
      target: { type: "filter", scope: "query", field: "v.department", op: "eq" },
    });
    const block = await h.service.saveBlock(context, {
      definition: blockDefinition,
      source_analysis_run_id: "completed",
    });
    const composed = structuredClone(blockDefinition);
    composed.block_references = [
      {
        block_id: block.block_id,
        version: 1,
        query_id_map: { visits: "visits" },
        parameter_map: {},
      },
    ];
    await expect(h.service.save(context, { definition: composed })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    composed.block_references[0].parameter_map = { department: "department" };
    await expect(h.service.save(context, { definition: composed })).resolves.toMatchObject({
      version: 1,
    });
  });
  it("产物来源必须同时声明所属分析运行", async () => {
    await expect(
      setup().service.save(context, { definition, source_artifact_id: "artifact" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
