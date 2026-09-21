import { z } from "zod";
import {
  reportDefinitionVersionSchema,
  reusableReportBlockSchema,
  saveReportDefinitionInputSchema,
  stableStringify,
  type ReportDefinition,
  type ReportDefinitionVersion,
  type ReusableReportBlock,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type {
  DefinitionDependencies,
  DefinitionKind,
  DefinitionListInput,
  DefinitionRecord,
} from "./report-definition-types";

const shareSchema = z
  .object({
    expected_version: z.number().int().positive(),
    shared_with: z.array(z.string().min(1).max(128)).max(1000),
  })
  .strict();
const listSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();
/** 任一编辑入口均提交同一结构；历史访问使用当前头记录 ACL。 */
class ReportDefinitionService {
  constructor(private readonly dependencies: DefinitionDependencies) {}
  async get(
    context: AuthContext,
    reportId: string,
    version?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportDefinitionVersion> {
    return reportDefinitionVersionSchema.parse(
      await this.read("report", context, reportId, version, executor),
    );
  }
  async save(
    context: AuthContext,
    input: unknown,
    reportId?: string,
    expectedVersion?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportDefinitionVersion> {
    return reportDefinitionVersionSchema.parse(
      await this.write("report", context, input, reportId, expectedVersion, executor),
    );
  }
  async getBlock(
    context: AuthContext,
    blockId: string,
    version?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<ReusableReportBlock> {
    return reusableReportBlockSchema.parse(
      await this.read("block", context, blockId, version, executor),
    );
  }
  async saveBlock(
    context: AuthContext,
    input: unknown,
    blockId?: string,
    expectedVersion?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<ReusableReportBlock> {
    const request = saveReportDefinitionInputSchema.parse(input);
    if (!request.source_analysis_run_id)
      throw new ApplicationError("INVALID_INPUT", "可复用块需要已完成的来源运行");
    return reusableReportBlockSchema.parse(
      await this.write("block", context, request, blockId, expectedVersion, executor),
    );
  }
  async share(
    context: AuthContext,
    reportId: string,
    input: unknown,
  ): Promise<ReportDefinitionVersion> {
    const request = shareSchema.parse(input);
    return this.dependencies.repository.transaction(async (executor) => {
      const current = await this.get(context, reportId, undefined, executor);
      return this.save(
        context,
        {
          definition: current.definition,
          source_analysis_run_id: current.source_analysis_run_id,
          source_artifact_id: current.source_artifact_id,
          shared_with: request.shared_with,
        },
        reportId,
        request.expected_version,
        executor,
      );
    });
  }
  async versions(context: AuthContext, reportId: string): Promise<ReportDefinitionVersion[]> {
    await this.get(context, reportId);
    const records = await this.dependencies.repository.versions(
      "report",
      context.organizationId,
      reportId,
    );
    const result: ReportDefinitionVersion[] = [];
    for (const record of records) {
      try {
        result.push(await this.get(context, reportId, record.version));
      } catch (error) {
        if (!(error instanceof ApplicationError && error.code === "NOT_FOUND")) throw error;
      }
    }
    return result;
  }
  async list(
    context: AuthContext,
    input: DefinitionListInput = {},
  ): Promise<{ items: ReportDefinitionVersion[]; next_cursor?: string }> {
    const result = await this.listKind("report", context, input);
    return {
      ...result,
      items: result.items.map((item) => reportDefinitionVersionSchema.parse(item)),
    };
  }
  async listBlocks(
    context: AuthContext,
    input: DefinitionListInput = {},
  ): Promise<{ items: ReusableReportBlock[]; next_cursor?: string }> {
    const result = await this.listKind("block", context, input);
    return { ...result, items: result.items.map((item) => reusableReportBlockSchema.parse(item)) };
  }
  async listTemplates(context: AuthContext): Promise<ReportDefinitionVersion[]> {
    const records = (await this.dependencies.listPublished?.(context)) ?? [];
    const available: ReportDefinitionVersion[] = [];
    for (const record of records) {
      try {
        await this.dependencies.validateDefinition(context, record.definition);
        available.push(record);
      } catch (error) {
        if (!this.isHidden(error)) throw error;
      }
    }
    return available;
  }
  private async read(
    kind: DefinitionKind,
    context: AuthContext,
    id: string,
    version?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<DefinitionRecord> {
    const latest = await this.dependencies.repository.find(
      kind,
      context.organizationId,
      id,
      undefined,
      executor,
    );
    if (
      !latest ||
      (latest.user_id !== context.userId && !latest.shared_with.includes(context.userId))
    ) {
      const published =
        kind === "report"
          ? ((await this.dependencies.listPublished?.(context, executor)) ?? [])
              .filter(
                (item) =>
                  item.report_id === id && (version === undefined || item.version === version),
              )
              .sort((a, b) => b.version - a.version)[0]
          : undefined;
      if (!published) throw new ApplicationError("NOT_FOUND", "报表定义不存在");
      await this.dependencies.validateDefinition(context, published.definition, executor);
      return published;
    }
    const record =
      version === undefined || version === latest.version
        ? latest
        : await this.dependencies.repository.find(
            kind,
            context.organizationId,
            id,
            version,
            executor,
          );
    if (!record) throw new ApplicationError("NOT_FOUND", "报表定义版本不存在");
    await this.dependencies.validateDefinition(context, record.definition, executor);
    return record;
  }
  private async write(
    kind: DefinitionKind,
    context: AuthContext,
    input: unknown,
    id?: string,
    expectedVersion?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<DefinitionRecord> {
    const request = saveReportDefinitionInputSchema.parse(input);
    if (request.source_artifact_id && !request.source_analysis_run_id)
      throw new ApplicationError("INVALID_INPUT", "来源产物必须同时声明所属分析运行");
    return this.dependencies.repository.transaction(async (transaction) => {
      if (id) {
        const current = await this.dependencies.repository.find(
          kind,
          context.organizationId,
          id,
          undefined,
          transaction,
        );
        if (expectedVersion === 0 && current)
          throw new ApplicationError("CONFLICT", "报表定义标识已存在");
        if ((current && current.user_id !== context.userId) || (!current && expectedVersion !== 0))
          throw new ApplicationError("NOT_FOUND", "报表定义不存在或不可修改");
      }
      await this.dependencies.repository.assertActiveUsers(
        context.organizationId,
        request.shared_with,
        transaction,
      );
      if (request.source_analysis_run_id) {
        const sources = await this.dependencies.repository.source(
          context,
          request.source_analysis_run_id,
          true,
          transaction,
          request.source_artifact_id,
        );
        for (const source of sources)
          await this.dependencies.authorizeEvidence(context, source, transaction);
      }
      await this.dependencies.validateDefinition(context, request.definition, transaction);
      await this.validateReferences(context, request.definition, transaction);
      return this.dependencies.repository.save(
        kind,
        context,
        request,
        id,
        expectedVersion,
        transaction,
      );
    }, executor);
  }
  private async validateReferences(
    context: AuthContext,
    definition: ReportDefinition,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    for (const reference of definition.block_references) {
      const block = await this.getBlock(context, reference.block_id, reference.version, executor);
      const source = block.definition;
      if (
        Object.keys(reference.query_id_map).length !== source.queries.length ||
        Object.keys(reference.parameter_map).length !== source.parameters.length ||
        new Set(Object.values(reference.query_id_map)).size !== source.queries.length
      )
        throw new ApplicationError("INVALID_INPUT", "可复用块须映射全部查询及参数");
      for (const parameter of source.parameters) {
        const target = definition.parameters.find(
          (item) => item.name === reference.parameter_map[parameter.name],
        );
        if (
          !target ||
          stableStringify({ ...parameter, name: target.name, label: target.label }) !==
            stableStringify(target)
        )
          throw new ApplicationError("INVALID_INPUT", "块参数映射缺失或定义不一致");
      }
      for (const query of source.queries) {
        const target = definition.queries.find(
          (item) => item.query_id === reference.query_id_map[query.query_id],
        );
        const mapped = {
          ...query,
          query_id: reference.query_id_map[query.query_id],
          bindings: query.bindings.map((binding) => ({
            ...binding,
            parameter: reference.parameter_map[binding.parameter],
          })),
        };
        if (!target || stableStringify(mapped) !== stableStringify(target))
          throw new ApplicationError("INVALID_INPUT", "块查询依赖缺失或已被改变");
      }
    }
  }
  private async listKind(
    kind: DefinitionKind,
    context: AuthContext,
    input: DefinitionListInput,
  ): Promise<{ items: DefinitionRecord[]; next_cursor?: string }> {
    const request = listSchema.parse(input);
    const items: DefinitionRecord[] = [];
    let cursor = request.cursor;
    while (items.length <= request.limit) {
      const records = await this.dependencies.repository.list(
        kind,
        context.organizationId,
        cursor,
        100,
      );
      for (const record of records) {
        cursor = "report_id" in record ? record.report_id : record.block_id;
        try {
          items.push(await this.read(kind, context, cursor));
        } catch (error) {
          if (!this.isHidden(error)) throw error;
        }
        if (items.length > request.limit) break;
      }
      if (records.length < 100 || items.length > request.limit) break;
    }
    const more = items.length > request.limit;
    const page = items.slice(0, request.limit);
    const last = page.at(-1);
    return {
      items: page,
      ...(more && last
        ? { next_cursor: "report_id" in last ? last.report_id : last.block_id }
        : {}),
    };
  }
  private isHidden(error: unknown): boolean {
    return (
      error instanceof ApplicationError &&
      [
        "NOT_FOUND",
        "UNAUTHORIZED",
        "UNAUTHORIZED_OBJECT",
        "UNAUTHORIZED_COLUMN",
        "POLICY_REJECTED",
      ].includes(error.code)
    );
  }
}
export { ReportDefinitionService };
