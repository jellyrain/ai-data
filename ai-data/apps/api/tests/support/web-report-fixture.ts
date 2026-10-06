import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import type { FastifyInstance } from "fastify";
import {
  queryDslSchema,
  queryEvidenceSchema,
  reportDefinitionVersionSchema,
  reportExecutionInputSchema,
  reportExecutionSchema,
  reportListInputSchema,
  reportNarrativeSchema,
  reportRevisionInputSchema,
  reportVersionListSchema,
  savedReportSchema,
  saveReportDefinitionInputSchema,
  reportSharingSchema,
  reportShareCandidatesInputSchema,
  reportSharingInputSchema,
  reportExportContentSchema,
  reportExecutionExportContentSchema,
  conversationExportContentSchema,
} from "@ai-data/contracts";
import type { ReportDefinitionVersion, ReportExecution, SavedReport } from "@ai-data/contracts";
import type { ApiAnalysisServices, ApiAuthService } from "../../src/app-types";
import type { AuthContext } from "../../src/auth/auth-types";
import { ApplicationError } from "../../src/errors/application-error";
import { registerReportManagementRoutes } from "../../src/routes/report-management-routes";
import { registerReportExecutionRoutes } from "../../src/routes/report-execution-routes";
import { registerMetricReportRoutes } from "../../src/routes/metric-report-routes";
import type { registerWebAnalysisFixture } from "./web-analysis-fixture";
/** 真实 HTTP 路由的确定性仓储，仅由浏览器验收进程装配。 */
function registerWebReportFixture(
  app: FastifyInstance,
  auth: ApiAuthService,
  analysis: ReturnType<typeof registerWebAnalysisFixture>,
) {
  const definitions = new Map<string, ReportDefinitionVersion[]>();
  const snapshots = new Map<string, SavedReport[]>();
  const executions = new Map<string, ReportExecution>();
  const operations = new Map<string, { input: string; id: string }>();
  const narrativeOperations = new Map<
    string,
    { input: string; executionId: string; conversation_id: string; analysis_run_id: string }
  >();
  const revisionTargets = new Map<string, { report_id: string; expected_version: number }>();
  const revisionOperations = new Map<
    string,
    { signature: string; conversation_id: string; analysis_run_id: string }
  >();
  const initialized = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const now = () => dayjs().format("YYYY-MM-DD HH:mm:ss");
  const key = (context: AuthContext, id: string) =>
    `${context.organizationId}:${context.userId}:${id}`;
  const unavailable = async () => {
    throw new ApplicationError("INVALID_INPUT", "此验收只开放读取和执行");
  };
  function makeDefinition(context: AuthContext, id: string, version: number) {
    return reportDefinitionVersionSchema.parse({
      report_id: id,
      version,
      organization_id: context.organizationId,
      user_id: context.userId,
      created_at: "2026-09-28 08:00:00",
      definition: {
        title:
          id === "report-01"
            ? "门诊与费用月报"
            : id === "report-02"
              ? "历史门诊快照"
              : id === "report-03"
                ? "待运行的门诊报表"
                : id === "report-04"
                  ? "科室明细 · 五千行"
                  : `业务报表 ${id.slice(-2)}`,
        parameters: [
          {
            name: "min",
            label: "最少人次",
            data_type: "integer",
            default_value: version === 1 ? 0 : 10,
            min: 0,
            max: 999,
          },
          { name: "flag", label: "包含停用", data_type: "boolean", default_value: false },
          { name: "note", label: "备注条件", data_type: "string", required: false },
        ],
        queries: (id === "report-04" ? ["visits"] : ["visits", "fees"]).map((query_id) => ({
          query_id,
          query: {
            type: "relational_query",
            source_id: "clinical",
            from: { object_id: query_id, alias: "v" },
            select: [{ field: "v.department" }, { field: "v.count" }],
          },
          bindings: [],
        })),
        presentation: [
          {
            section_id: "overview",
            title: "科室业务概览",
            blocks: [
              {
                block_id: "visits",
                type: "table",
                title: "门诊人次",
                query_ids: ["visits"],
                columns: ["department", "count"],
              },
              {
                block_id: "distribution",
                type: "chart",
                title: "科室分布",
                query_ids: ["visits"],
                chart: { type: "bar", x: "department", y: "count" },
              },
              ...(id === "report-04"
                ? []
                : [{ block_id: "fees", type: "table", title: "费用合计", query_ids: ["fees"] }]),
            ],
          },
        ],
      },
    });
  }
  function completed(
    context: AuthContext,
    definition: ReportDefinitionVersion,
    parameters: ReportExecution["parameters"],
    id = randomUUID(),
  ) {
    const reportId = definition.report_id,
      runId = `query-${id}`;
    const count = reportId === "report-04" ? 5000 : parameters.min === 100 ? 0 : 6;
    const results = definition.definition.queries.map((item) => {
      const query = queryDslSchema.parse(item.query);
      return {
        query_id: item.query_id,
        evidence: queryEvidenceSchema.parse({
          evidence_id: randomUUID(),
          analysis_run_id: runId,
          tool_call_id: item.query_id,
          organization_id: context.organizationId,
          user_id: context.userId,
          created_at: now(),
          requested_query: query,
          authorized_query: query,
          output_masks: [],
          result: {
            columns: [
              { name: "department", data_type: "string" },
              { name: "count", data_type: "integer" },
            ],
            rows: Array.from({ length: count }, (_, index) => ({
              department:
                index < 6
                  ? ["内科", "外科", "儿科", "妇产科", "眼科", "骨科"][index]
                  : `科室 ${index + 1}`,
              count: (index + 1) * (item.query_id === "fees" ? 10000 : 40),
            })),
            row_count: count,
            truncated: false,
          },
        }),
      };
    });
    const history = snapshots.get(key(context, reportId)) ?? [];
    const snapshot = savedReportSchema.parse({
      report_id: reportId,
      version: history.length + 1,
      definition_version: definition.version,
      execution_id: id,
      organization_id: context.organizationId,
      user_id: context.userId,
      analysis_run_id: runId,
      created_at: now(),
      title: definition.definition.title,
      sources: results.map((result) => result.evidence),
      sections: definition.definition.presentation.map((section) => ({
        ...section,
        blocks: section.blocks.map((block) => {
          const { query_ids, ...value } = block;
          delete value.source_execution_id;
          return {
            ...value,
            evidence_ids: query_ids.map(
              (queryId) =>
                results.find((result) => result.query_id === queryId)!.evidence.evidence_id,
            ),
          };
        }),
      })),
    });
    const record = reportExecutionSchema.parse({
      execution_id: id,
      report_id: reportId,
      organization_id: context.organizationId,
      user_id: context.userId,
      definition_version: definition.version,
      definition: definition.definition,
      parameters,
      status: "completed",
      analysis_run_id: runId,
      lease_epoch: 1,
      created_at: now(),
      completed_at: now(),
      deadline: dayjs().add(120, "second").format("YYYY-MM-DD HH:mm:ss"),
      results: results.reverse(),
      snapshot,
    });
    executions.set(id, record);
    snapshots.set(key(context, reportId), [...history, snapshot]);
    return record;
  }
  function seed(context: AuthContext) {
    const identity = key(context, "");
    if (initialized.has(identity)) return;
    initialized.add(identity);
    for (let index = 1; index <= 23; index++) {
      const id = `report-${String(index).padStart(2, "0")}`;
      const first = makeDefinition(context, id, 1),
        second = makeDefinition(context, id, 2);
      definitions.set(key(context, id), [first, second]);
      if (id === "report-01") {
        completed(context, first, { min: 0, flag: false });
        completed(context, second, { min: 10, flag: false });
      }
      if (id === "report-02") {
        const record = completed(context, first, {});
        const old = { ...record.snapshot! };
        delete old.execution_id;
        delete old.definition_version;
        snapshots.set(key(context, id), [old]);
        definitions.delete(key(context, id));
      }
      if (id === "report-04") completed(context, second, { min: 10, flag: false });
    }
  }
  async function getDefinition(context: AuthContext, id: string, version?: number) {
    seed(context);
    const items = definitions.get(key(context, id));
    const result = version ? items?.find((item) => item.version === version) : items?.at(-1);
    if (!result) throw new ApplicationError("NOT_FOUND", "报表定义不存在");
    return structuredClone(result);
  }
  async function getSnapshot(context: AuthContext, id: string, version?: number) {
    seed(context);
    const items = snapshots.get(key(context, id));
    const result = version ? items?.find((item) => item.version === version) : items?.at(-1);
    if (!result) throw new ApplicationError("NOT_FOUND", "结果不存在");
    return structuredClone(result);
  }
  async function getExecution(context: AuthContext, id: string) {
    const record = executions.get(id);
    if (
      !record ||
      record.user_id !== context.userId ||
      record.organization_id !== context.organizationId
    )
      throw new ApplicationError("NOT_FOUND", "执行不存在");
    return structuredClone(record);
  }
  const members = Array.from({ length: 45 }, (_, index) => ({
    user_id: `member-${String(index + 1).padStart(3, "0")}`,
    username: `analyst${index + 1}`,
    display_name: index < 2 ? "同名成员" : `成员 ${index + 1}`,
  }));
  async function sharingHead(context: AuthContext, id: string) {
    seed(context);
    const definition = definitions.get(key(context, id))?.at(-1),
      snapshot = snapshots.get(key(context, id))?.at(-1),
      record = definition ?? snapshot;
    if (!record) throw new ApplicationError("NOT_FOUND", "报表不存在");
    return reportSharingSchema.parse({
      report_id: id,
      basis: definition ? "definition" : "snapshot",
      expected_version: record.version,
      owner_user_id: record.user_id,
      shared_with: record.shared_with,
      members: record.shared_with.map((user_id) => ({
        ...members.find((m) => m.user_id === user_id)!,
        status: "active",
      })),
    });
  }
  async function savedNarratives(context: AuthContext, id: string) {
    const execution = await getExecution(context, id),
      items = [];
    for (const operation of narrativeOperations.values()) {
      if (operation.executionId !== id) continue;
      const run = await analysis.runs.get(context, operation.analysis_run_id);
      if (run.status === "completed")
        items.push(
          reportNarrativeSchema.parse({
            execution_id: id,
            analysis_run_id: run.analysis_run_id,
            content:
              "## 本次报表分析\n\n六个科室的门诊与费用结果已核对。内科门诊 **40 人次**，内科费用 **10,000 元**。\n\n说明依据本次执行已保存的结果。",
            query_ids: execution.definition.queries.map((item) => item.query_id),
            created_at: run.updated_at,
          }),
        );
    }
    return items;
  }
  registerReportManagementRoutes(app, auth, {
    sharing: {
      get: sharingHead,
      candidates: async (context, id, input) => {
        await sharingHead(context, id);
        const request = reportShareCandidatesInputSchema.parse(input);
        const matching = members.filter(
          (m) =>
            (!request.cursor || m.user_id > request.cursor) &&
            (!request.search || `${m.username} ${m.display_name}`.includes(request.search)),
        );
        return {
          items: matching.slice(0, request.limit),
          ...(matching.length > request.limit
            ? { next_cursor: matching[request.limit - 1]!.user_id }
            : {}),
        };
      },
    },
    definitions: {
      get: getDefinition,
      save: async (context, input, id, expectedVersion) => {
        const value = saveReportDefinitionInputSchema.parse(input),
          reportId = id ?? `editor-${randomUUID()}`;
        seed(context);
        const previous = definitions.get(key(context, reportId)) ?? [];
        if (id && !previous.length) throw new ApplicationError("NOT_FOUND", "报表不存在");
        if (id && previous.at(-1)!.version !== expectedVersion)
          throw new ApplicationError("CONFLICT", "报表版本已更新");
        const record = reportDefinitionVersionSchema.parse({
          ...value,
          report_id: reportId,
          version: previous.length + 1,
          organization_id: context.organizationId,
          user_id: context.userId,
          created_at: now(),
        });
        definitions.set(key(context, reportId), [...previous, record]);
        return structuredClone(record);
      },
      saveBlock: unavailable,
      getBlock: unavailable,
      listBlocks: unavailable,
      listTemplates: unavailable,
    },
    management: {
      list: async (context, input) => {
        seed(context);
        const request = reportListInputSchema.parse(input);
        const ids = [
          ...Array.from({ length: 23 }, (_, i) => `report-${String(i + 1).padStart(2, "0")}`),
          ...[...definitions.values()].flatMap((items) => {
            const record = items.at(-1)!;
            return record.organization_id === context.organizationId &&
              record.user_id === context.userId &&
              record.report_id.startsWith("editor-")
              ? [record.report_id]
              : [];
          }),
        ]
          .sort()
          .filter((id) => !request.cursor || id > request.cursor);
        return {
          items: ids.slice(0, request.limit).map((id) => {
            const definition = definitions.get(key(context, id))?.at(-1),
              snapshot = snapshots.get(key(context, id))?.at(-1);
            return {
              report_id: id,
              title: definition?.definition.title ?? snapshot!.title,
              user_id: context.userId,
              created_at: definition?.created_at ?? snapshot!.created_at,
              shared_with: [],
              description: definition?.definition.description,
              display_type: "legacy",
              updated_at: definition?.created_at ?? snapshot!.created_at,
              ...(definition ? { definition_version: definition.version } : {}),
              ...(snapshot ? { snapshot_version: snapshot.version } : {}),
            };
          }),
          ...(ids.length > request.limit ? { next_cursor: ids[request.limit - 1] } : {}),
        };
      },
      versions: async (context, id) => {
        seed(context);
        const result = {
          definitions: definitions.get(key(context, id)) ?? [],
          snapshots: snapshots.get(key(context, id)) ?? [],
        };
        if (!result.definitions.length && !result.snapshots.length)
          throw new ApplicationError("NOT_FOUND", "报表不存在");
        return reportVersionListSchema.parse(result);
      },
      share: async (context, id, input) => {
        const request = reportSharingInputSchema.parse(input),
          head = await sharingHead(context, id);
        if (head.expected_version !== request.expected_version)
          throw new ApplicationError("CONFLICT", "分享版本已变化");
        if (request.shared_with.some((userId) => !members.some((m) => m.user_id === userId)))
          throw new ApplicationError("INVALID_INPUT", "成员不可用");
        const records = definitions.get(key(context, id));
        if (records) {
          const saved = reportDefinitionVersionSchema.parse({
            ...records.at(-1)!,
            version: head.expected_version + 1,
            shared_with: request.shared_with,
            created_at: now(),
          });
          records.push(saved);
          return saved;
        }
        const snapshotsList = snapshots.get(key(context, id))!;
        const saved = savedReportSchema.parse({
          ...snapshotsList.at(-1)!,
          version: head.expected_version + 1,
          shared_with: request.shared_with,
          created_at: now(),
        });
        snapshotsList.push(saved);
        return saved;
      },
      exportReport: async (context, id, version) => {
        const report = await getSnapshot(context, id, version);
        return reportExportContentSchema.parse({
          kind: "report",
          report,
          tables: report.sources.map((evidence) => ({
            evidence,
            availability: evidence.result.truncated ? "truncated" : "complete",
          })),
        });
      },
      artifacts: unavailable,
      exportConversation: async (context, id) => {
        const detail = await analysis.conversations.get(context, id);
        if (!detail) throw new ApplicationError("NOT_FOUND", "会话不存在");
        const ids = [
          ...new Set(
            detail.messages.flatMap((message) =>
              message.analysisRunId ? [message.analysisRunId] : [],
            ),
          ),
        ];
        const runs = await Promise.all(ids.map((runId) => analysis.runs.get(context, runId)));
        const sources = (
          await Promise.all(
            runs
              .filter((run) => run.status === "completed")
              .map((run) => analysis.runs.evidence(context, run.analysis_run_id)),
          )
        ).flat();
        return conversationExportContentSchema.parse({
          kind: "conversation",
          conversation_id: id,
          title: detail.conversation.title,
          messages: detail.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              message_id: m.id,
              role: m.role,
              sequence: m.sequence,
              content: m.content,
              ...(m.analysisRunId ? { analysis_run_id: m.analysisRunId } : {}),
              created_at: dayjs(m.createdAt).format("YYYY-MM-DD HH:mm:ss"),
            })),
          runs: runs.map((run) => ({ analysis_run_id: run.analysis_run_id, status: run.status })),
          artifacts: [],
          tables: sources.map((evidence) => ({
            evidence,
            availability: evidence.result.truncated ? "truncated" : "complete",
          })),
        });
      },
    },
  });
  registerMetricReportRoutes(
    app,
    auth,
    {
      metrics: { list: unavailable, get: unavailable, execute: unavailable },
      reports: { save: unavailable, get: getSnapshot },
    } as unknown as ApiAnalysisServices,
    { submitMetric: unavailable },
  );
  registerReportExecutionRoutes(app, auth, {
    executions: {
      get: getExecution,
      exportContent: async (context, id) =>
        reportExecutionExportContentSchema.parse({
          kind: "report_execution",
          execution: await getExecution(context, id),
          narratives: await savedNarratives(context, id),
        }),
      execute: async (context, id, input) => {
        const request = reportExecutionInputSchema.parse(input),
          operation = key(context, `${id}:${request.idempotency_key}`),
          signature = JSON.stringify(request);
        const prior = operations.get(operation);
        if (prior) {
          if (prior.input !== signature) throw new ApplicationError("CONFLICT", "幂等内容不一致");
          return getExecution(context, prior.id);
        }
        const definition = await getDefinition(context, id, request.definition_version);
        const parameters = Object.assign(
          Object.fromEntries(
            definition.definition.parameters
              .filter((parameter) => parameter.default_value !== undefined)
              .map((parameter) => [parameter.name, parameter.default_value]),
          ),
          request.parameters,
        );
        const executionId = randomUUID();
        if (parameters.min === 88)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 21_000);
            timers.add(timer);
          });
        let record: ReportExecution;
        if (parameters.min === 999) {
          record = reportExecutionSchema.parse({
            execution_id: executionId,
            report_id: id,
            organization_id: context.organizationId,
            user_id: context.userId,
            definition_version: definition.version,
            definition: definition.definition,
            parameters,
            status: "failed",
            analysis_run_id: `query-${executionId}`,
            lease_epoch: 1,
            created_at: now(),
            completed_at: now(),
            deadline: now(),
            results: [],
            error_code: "QUERY_TIMEOUT",
          });
          executions.set(executionId, record);
        } else record = completed(context, definition, parameters, executionId);
        operations.set(operation, { input: signature, id: executionId });
        return structuredClone(record);
      },
    },
    revisions: {
      binding: async (context, id, runId) => {
        const target = revisionTargets.get(key(context, runId));
        if (!target || target.report_id !== id)
          throw new ApplicationError("NOT_FOUND", "报表修改任务不存在");
        await getDefinition(context, id, target.expected_version);
        return { ...target, analysis_run_id: runId };
      },
      revise: async (context, id, input) => {
        const request = reportRevisionInputSchema.parse(input);
        const operationKey = key(context, `${id}:${request.idempotency_key}`),
          signature = JSON.stringify(request);
        const prior = revisionOperations.get(operationKey);
        if (prior) {
          if (prior.signature !== signature)
            throw new ApplicationError("CONFLICT", "幂等内容不一致");
          return { conversation_id: prior.conversation_id, analysis_run_id: prior.analysis_run_id };
        }
        const definition = await getDefinition(context, id);
        if (definition.version !== request.expected_version)
          throw new ApplicationError("CONFLICT", "报表版本已更新");
        const conversation = await analysis.conversations.create(context, "报表修改");
        const submission = await analysis.conversations.submitUserMessage(
          context,
          conversation.id,
          request.prompt,
          request.idempotency_key,
        );
        if (!submission) throw new ApplicationError("INTERNAL_ERROR", "修改创建失败");
        const receipt = {
          conversation_id: conversation.id,
          analysis_run_id: submission.analysisRun.id,
        };
        revisionTargets.set(key(context, receipt.analysis_run_id), {
          report_id: id,
          expected_version: request.expected_version,
        });
        revisionOperations.set(operationKey, { ...receipt, signature });
        // 与生产语义一致：成功终态前提交；读取绑定和运行本身没有写入副作用。
        analysis.onComplete(receipt.analysis_run_id, () => {
          const history = definitions.get(key(context, id))!;
          if (history.at(-1)!.version !== request.expected_version)
            throw new Error("报表版本已更新");
          history.push(
            reportDefinitionVersionSchema.parse({
              ...definition,
              version: request.expected_version + 1,
              definition: { ...definition.definition, title: "AI 修改后的报表" },
              created_at: now(),
            }),
          );
        });
        return receipt;
      },
      narrate: async (context, executionId, input) => {
        await getExecution(context, executionId);
        const { prompt, idempotency_key: operationKey } = input as {
          prompt: string;
          idempotency_key: string;
        };
        const operation = key(context, `${executionId}:${operationKey}`),
          prior = narrativeOperations.get(operation);
        if (prior) {
          if (prior.input !== prompt) throw new ApplicationError("CONFLICT", "幂等内容不一致");
          return { conversation_id: prior.conversation_id, analysis_run_id: prior.analysis_run_id };
        }
        const conversation = await analysis.conversations.create(context, "报表分析说明");
        const receipt = await analysis.conversations.submitUserMessage(
          context,
          conversation.id,
          prompt,
          operationKey,
        );
        if (!receipt) throw new ApplicationError("INTERNAL_ERROR", "说明创建失败");
        const result = {
          conversation_id: conversation.id,
          analysis_run_id: receipt.analysisRun.id,
        };
        narrativeOperations.set(operation, { ...result, input: prompt, executionId });
        return result;
      },
      narratives: async (context, id) => {
        const execution = await getExecution(context, id),
          items = [];
        for (const operation of narrativeOperations.values()) {
          if (operation.executionId !== id) continue;
          const run = await analysis.runs.get(context, operation.analysis_run_id);
          if (run.status === "completed")
            items.push(
              reportNarrativeSchema.parse({
                execution_id: id,
                analysis_run_id: run.analysis_run_id,
                content:
                  "## 本次报表分析\n\n六个科室的门诊与费用结果已核对。内科门诊 **40 人次**，内科费用 **10,000 元**。\n\n说明依据本次执行已保存的结果。",
                query_ids: execution.definition.queries.map((item) => item.query_id),
                created_at: now(),
              }),
            );
        }
        return items;
      },
    },
  });
  app.addHook("onClose", async () => {
    for (const timer of timers) clearTimeout(timer);
  });
}
export { registerWebReportFixture };
