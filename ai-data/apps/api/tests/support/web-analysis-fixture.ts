import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  agentVersionSchema,
  analysisRunSchema,
  clarificationAnswerSchema,
  queryEvidenceSchema,
  queryDslSchema,
  sseEventSchema,
} from "@ai-data/contracts";
import type {
  AgentVersion,
  AnalysisRunState,
  AnalysisStep,
  QueryEvidence,
  SseEvent,
} from "@ai-data/contracts";
import type { FastifyInstance } from "fastify";
import type { ApiAnalysisServices, ApiAuthService } from "../../src/app-types";
import type { AuthContext } from "../../src/auth/auth-types";
import type {
  Conversation,
  ConversationMessage,
  ConversationRepository,
  SubmittedMessage,
} from "../../src/conversations/conversation-types";
import type { RunEvent } from "../../src/analysis-runs/analysis-run-types";
import { ConversationService } from "../../src/conversations/conversation-service";
import { registerConversationRoutes } from "../../src/routes/conversation-routes";
import { registerAnalysisRoutes } from "../../src/routes/analysis-routes";
import { registerAgentRoutes } from "../../src/routes/agent-routes";
import { ApplicationError } from "../../src/errors/application-error";

dayjs.extend(utc);
const now = () => dayjs().utcOffset(480).format("YYYY-MM-DD HH:mm:ss");
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const agent: AgentVersion = agentVersionSchema.parse({
  agent_id: "clinical",
  version: 1,
  name: "业务分析助手",
  description: "浏览器验收用确定性 Agent",
  instructions: "",
  model_id: "fixture",
  model_version: 1,
  tool_names: ["query_dataset"],
  skill_names: [],
  limits: { timeout_ms: 60000, max_tool_calls: 10, max_context_bytes: 64000 },
  skill_fingerprint: "a".repeat(64),
  enabled: true,
});
/** 隔离 HTTP 验收数据；运行调度和 SQL 结果为确定性替身，认证与路由使用真实实现。 */
class WebAnalysisRepository implements ConversationRepository {
  deleted = new Set<string>();
  reportConversations = new Set<string>();
  conversations = new Map<string, Conversation>();
  messages = new Map<string, ConversationMessage[]>();
  states = new Map<string, AnalysisRunState>();
  events = new Map<string, SseEvent[]>();
  evidence = new Map<string, QueryEvidence[]>();
  steps = new Map<string, AnalysisStep[]>();
  submissions = new Map<string, SubmittedMessage>();
  answers = new Map<string, string>();
  questions = new Map<string, string>();
  timers = new Set<ReturnType<typeof setTimeout>>();
  completions = new Map<string, () => void>();
  subscribers = new Map<string, Set<() => void>>();
  subscribeEvents(id: string, notify: () => void) {
    const subscribers = this.subscribers.get(id) ?? new Set<() => void>();
    subscribers.add(notify);
    this.subscribers.set(id, subscribers);
    return () => {
      subscribers.delete(notify);
      if (!subscribers.size) this.subscribers.delete(id);
    };
  }
  schedule(operation: () => void, delay: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      operation();
    }, delay);
    this.timers.add(timer);
  }
  close() {
    for (const timer of this.timers) clearTimeout(timer);
  }
  async createConversation(conversation: Conversation) {
    this.conversations.set(conversation.id, conversation);
    this.messages.set(conversation.id, []);
  }
  async findConversation(id: string, userId: string, organizationId: string) {
    if (this.deleted.has(id)) return null;
    const item = this.conversations.get(id);
    return item?.userId === userId && item.organizationId === organizationId ? item : null;
  }
  async listConversations(userId: string, organizationId: string) {
    return [...this.conversations.values()].filter(
      (item) =>
        item.userId === userId &&
        item.organizationId === organizationId &&
        !this.deleted.has(item.id) &&
        !this.reportConversations.has(item.id),
    );
  }
  async listMessages(id: string) {
    return this.messages.get(id) ?? [];
  }
  async deleteConversations(ids: string[], userId: string, organizationId: string) {
    for (const id of ids) {
      const item = this.conversations.get(id);
      if (
        !item ||
        item.userId !== userId ||
        item.organizationId !== organizationId ||
        this.reportConversations.has(id)
      )
        throw new ApplicationError("NOT_FOUND", "会话不存在或不属于当前工作台");
      if (
        [...this.states.values()].some(
          (state) => state.conversation_id === id && !terminal(state.status),
        )
      )
        throw new ApplicationError("CONFLICT", "所选会话仍有分析任务，请先停止后再删除");
    }
    ids.forEach((id) => this.deleted.add(id));
  }
  get(context: AuthContext, id: string) {
    const state = this.states.get(id);
    if (
      !state ||
      this.deleted.has(state.conversation_id) ||
      state.user_id !== context.userId ||
      state.organization_id !== context.organizationId
    )
      throw new ApplicationError("NOT_FOUND", "分析运行不存在");
    return state;
  }
  emit(id: string, event: RunEvent) {
    const state = this.states.get(id)!;
    state.sequence++;
    state.updated_at = now();
    this.events.get(id)!.push(
      sseEventSchema.parse({
        ...event,
        conversation_id: state.conversation_id,
        analysis_run_id: id,
        sequence: state.sequence,
        lease_epoch: state.lease_epoch,
      }),
    );
    for (const notify of this.subscribers.get(id) ?? []) notify();
  }
  message(id: string, role: "assistant" | "user", content: string) {
    const state = this.states.get(id)!;
    const messages = this.messages.get(state.conversation_id)!;
    messages.push({
      id: randomUUID(),
      conversationId: state.conversation_id,
      analysisRunId: id,
      role,
      content,
      sequence: messages.length + 1,
      createdAt: dayjs().toDate(),
    });
  }
  async submitMessage(
    conversationId: string,
    userId: string,
    organizationId: string,
    content: string,
    key: string,
  ): Promise<SubmittedMessage | null> {
    const conversation = await this.findConversation(conversationId, userId, organizationId);
    if (!conversation) return null;
    const identity = `${conversationId}:${key}`;
    const prior = this.submissions.get(identity);
    if (prior) {
      if (prior.message.content !== content)
        throw new ApplicationError("CONFLICT", "幂等内容不一致");
      return prior;
    }
    if (
      [...this.states.values()].some(
        (state) => state.conversation_id === conversationId && !terminal(state.status),
      )
    )
      throw new ApplicationError("CONFLICT", "当前会话已有运行");
    const id = randomUUID();
    const created = dayjs().toDate();
    const messages = this.messages.get(conversationId)!;
    const message: ConversationMessage = {
      id: randomUUID(),
      conversationId,
      role: "user",
      content,
      sequence: messages.length + 1,
      createdAt: created,
    };
    const receipt: SubmittedMessage = {
      message,
      analysisRun: {
        id,
        conversationId,
        organizationId,
        userId,
        status: "created",
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: created,
      },
    };
    messages.push({ ...message, analysisRunId: id });
    conversation.updatedAt = created;
    this.submissions.set(identity, receipt);
    this.questions.set(id, content);
    this.states.set(
      id,
      analysisRunSchema.parse({
        analysis_run_id: id,
        conversation_id: conversationId,
        organization_id: organizationId,
        user_id: userId,
        agent_id: "clinical",
        agent_version: 1,
        status: "running",
        created_at: now(),
        updated_at: now(),
        lease_epoch: 1,
        lease: null,
        sequence: 0,
        clarification: null,
        evidence_ids: [],
        error: null,
      }),
    );
    this.events.set(id, []);
    this.evidence.set(id, []);
    this.steps.set(id, []);
    this.emit(id, { type: "run_started" });
    this.emit(id, { type: "progress", message: "正在核对分析范围与授权数据" });
    this.schedule(
      () => {
        const state = this.states.get(id)!;
        if (terminal(state.status)) return;
        if (content.includes("澄清")) {
          state.status = "waiting_clarification";
          state.clarification = {
            clarification_id: randomUUID(),
            question: "希望分析哪个时间范围？",
            options: [
              { id: "year", label: "本年" },
              { id: "month", label: "本月" },
            ],
            allow_custom_input: true,
            ...(content.includes("偏好")
              ? { preference_confirmation_id: "fixture-preference" }
              : {}),
          };
          this.emit(id, { type: "clarification", ...state.clarification });
          this.message(id, "assistant", state.clarification.question);
        } else if (content.includes("流式")) this.stream(id);
        else this.finish(id);
      },
      content.includes("慢速") ? 30000 : 500,
    );
    return receipt;
  }
  /** 有时间间隔的文字/工具/文字，用于证明浏览器在最终完成前消费真实 SSE 数据块。 */
  stream(id: string) {
    const stages: [number, RunEvent][] = [
      [
        0,
        {
          type: "assistant_message",
          message_id: "before",
          phase: "commentary",
          status: "started",
          content: "",
        },
      ],
      [
        150,
        {
          type: "assistant_message",
          message_id: "before",
          phase: "commentary",
          status: "delta",
          content: "我先核对本年的",
        },
      ],
      [
        800,
        {
          type: "assistant_message",
          message_id: "before",
          phase: "commentary",
          status: "delta",
          content: "门诊数据和科室范围。",
        },
      ],
      [
        1400,
        {
          type: "assistant_message",
          message_id: "before",
          phase: "commentary",
          status: "completed",
          content: "我先核对本年的门诊数据和科室范围。",
        },
      ],
      [
        1600,
        {
          type: "tool_call",
          tool_call_id: "catalog",
          tool_name: "get_business_schema",
          input_summary: "读取已授权门诊字段",
        },
      ],
      [
        3400,
        {
          type: "tool_result",
          tool_call_id: "catalog",
          tool_name: "get_business_schema",
          success: true,
          output_summary: "已取得科室、就诊日期与人次字段",
          duration_ms: 1800,
        },
      ],
      [
        3700,
        {
          type: "assistant_message",
          message_id: "after",
          phase: "commentary",
          status: "delta",
          content: "字段已确认。接下来查询",
        },
      ],
      [
        4300,
        {
          type: "assistant_message",
          message_id: "after",
          phase: "commentary",
          status: "delta",
          content: "本年各科室的门诊记录。",
        },
      ],
      [
        4900,
        {
          type: "assistant_message",
          message_id: "after",
          phase: "commentary",
          status: "completed",
          content: "字段已确认。接下来查询本年各科室的门诊记录。",
        },
      ],
      [
        5200,
        {
          type: "tool_call",
          tool_call_id: "query-1",
          tool_name: "query_dataset",
          input_summary: "业务量 · 本年 · 已授权科室",
        },
      ],
    ];
    for (const [delay, event] of stages)
      this.schedule(() => {
        if (!terminal(this.states.get(id)!.status)) this.emit(id, event);
      }, delay);
    this.schedule(() => this.finish(id, true), 6800);
  }
  finish(id: string, streaming = false) {
    const state = this.states.get(id)!;
    if (terminal(state.status)) return;
    const question = this.questions.get(id) ?? "";
    const layout = question.includes("布局验收");
    if (question.includes("失败")) {
      state.status = "failed";
      state.error = { code: "DATA_SOURCE_UNAVAILABLE", message: "测试数据源暂时不可用" };
      this.emit(id, { type: "run_failed", ...state.error });
      return;
    }
    state.status = "running";
    this.emit(id, {
      type: "thinking",
      stage: "querying",
      content: "按已确认的时间范围读取数据，并保留本次查询的依据。",
    });
    this.emit(id, {
      type: "context_compaction",
      item_id: "compact-fixture",
      status: "started",
      occurred_at: now(),
    });
    this.emit(id, {
      type: "context_compaction",
      item_id: "compact-fixture",
      status: "completed",
      occurred_at: now(),
    });
    if (layout) {
      this.emit(id, {
        type: "tool_call",
        tool_call_id: "query-failed",
        tool_name: "query_dataset",
        input_summary: "门诊人次 · 时间格式校验",
      });
      this.emit(id, {
        type: "tool_result",
        tool_call_id: "query-failed",
        tool_name: "query_dataset",
        success: false,
        output_summary: "时间格式不符合 datetime 要求",
        duration_ms: 12,
      });
    }
    if (!streaming)
      this.emit(id, {
        type: "tool_call",
        tool_call_id: "query-1",
        tool_name: "query_dataset",
        input_summary: "业务量 · 本年 · 已授权科室",
      });
    const query = queryDslSchema.parse({
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "outpatient", alias: "v" },
      select: [
        { field: "v.department" },
        { field: "v.visits" },
        { field: "v.date" },
        { field: "v.note" },
      ],
      filters: {
        logic: "and",
        items: [
          {
            field: "v.date",
            op: "between",
            data_type: "date",
            value: ["2026-01-01", "2026-12-31"],
          },
        ],
      },
      limit: 5000,
    });
    const count = question.includes("空结果") ? 0 : layout ? 17 : 5000;
    const truncated = question.includes("截断");
    const item = queryEvidenceSchema.parse({
      evidence_id: randomUUID(),
      tool_call_id: "query-1",
      analysis_run_id: id,
      user_id: state.user_id,
      organization_id: state.organization_id,
      created_at: now(),
      requested_query: query,
      authorized_query: query,
      output_masks: [],
      metric: { metric_id: "outpatient-visits", version: 1 },
      result: {
        columns: [
          { name: "department", data_type: "string" },
          { name: "visits", data_type: "integer" },
          { name: "date", data_type: "date" },
          { name: "note", data_type: "string" },
        ],
        rows: Array.from({ length: count }, (_, index) => ({
          department: `科室 ${index + 1}`,
          visits: 10 + (index % 23),
          date: "2026-09-01",
          note:
            index === 0
              ? "需要完整展开阅读的长单元格。".repeat(20)
              : index % 7 === 0
                ? null
                : "已核对",
        })),
        row_count: count,
        truncated,
        delivery: truncated
          ? { status: "truncated", total_row_count: null }
          : { status: "complete", total_row_count: count },
        freshness: "2026-09-27 08:00:00",
        execution_sql: {
          dialect: "sqlserver",
          sql: "SELECT [v].[department], [v].[visits] FROM [dbo].[outpatient] AS [v] WHERE [v].[date] >= @p1",
          parameters: [{ position: 1, placeholder: "@p1", data_type: "date" }],
        },
      },
    });
    const items = [item];
    if (layout) {
      const totalQuery = queryDslSchema.parse({
        ...query,
        select: [{ field: "v.visits", aggregation: "count", as: "count" }],
      });
      items.push(
        queryEvidenceSchema.parse({
          ...item,
          evidence_id: randomUUID(),
          requested_query: totalQuery,
          authorized_query: totalQuery,
          result: {
            columns: [{ name: "count", data_type: "integer" }],
            rows: [{ count: 10053 }],
            row_count: 1,
            truncated: false,
            execution_sql: {
              dialect: "sqlserver",
              sql: "SELECT COUNT([v].[visits]) AS [count] FROM [dbo].[outpatient] AS [v]",
              parameters: [],
            },
          },
        }),
      );
    }
    this.evidence.set(id, items);
    state.evidence_ids = items.map((value) => value.evidence_id);
    this.steps.set(id, [
      {
        step_id: randomUUID(),
        analysis_run_id: id,
        title: "核对门诊业务量",
        conclusion: "已读取并核对本次查询结果范围。",
        status: "supported",
        evidence_ids: [item.evidence_id],
      },
    ]);
    this.emit(id, {
      type: "tool_result",
      tool_call_id: "query-1",
      tool_name: "query_dataset",
      success: true,
      output_summary: layout
        ? JSON.stringify({ row_count: count, evidence_ids: state.evidence_ids }, null, 2)
        : `已返回 ${count} 行`,
      input_summary: "数据源 clinical · 门诊科室明细",
      duration_ms: 320,
    });
    this.emit(id, {
      type: "table",
      evidence_id: item.evidence_id,
      columns: item.result.columns,
      rows: item.result.rows.slice(0, 100),
      result_row_count: count,
      result_truncated: truncated,
      sampled: count > 100,
    });
    if (layout) {
      const total = items[1]!;
      this.emit(id, {
        type: "table",
        evidence_id: total.evidence_id,
        columns: total.result.columns,
        rows: total.result.rows,
        result_row_count: 1,
        sampled: false,
      });
    }
    const content = layout
      ? `## 今年门诊人次（截至 2026-10-08）\n\n全年累计门诊就诊人次：**10,053 人次**，覆盖 **17 个科室**。\n\n|科室|门诊人次|\n|---|---|\n${["康复科|682", "心内科|682", "神经内科|682", "消化科|673", "口腔科|650", "呼吸科|636", "皮肤科|614", "泌尿科|599", "耳鼻喉科|576", "产科|562", "眼科|539", "儿科|527", "中医科|527", "妇科|526", "骨科|526", "内科|526", "外科|526"].map((row) => `|${row}|`).join("\n")}\n\n统计范围：2026-01-01 至 2026-10-08。\n\n此页面使用隔离的浏览器验收数据。`
      : `## 门诊分析结论\n\n本次查询已交付 **${count.toLocaleString()} 条记录**。请结合查询范围阅读结果，科室变化可在图表中进一步查看。\n\n- 时间范围：2026 年\n- 数据来源：clinical\n\n### 分析流程\n\n\`\`\`mermaid\nflowchart LR\n A[确认范围] --> B[读取授权数据]\n B --> C[核对结果]\n\`\`\`\n\n\`\`\`sql\nSELECT department, visits FROM outpatient;\n\`\`\`\n\n> 此页面使用隔离的浏览器验收数据。`;
    const finalize = () => {
      if (terminal(state.status)) return;
      this.message(id, "assistant", content);
      if (streaming)
        this.emit(id, {
          type: "assistant_message",
          message_id: "answer",
          phase: "final_answer",
          status: "completed",
          content,
        });
      this.emit(id, {
        type: "final_answer",
        content,
        ...(streaming ? { message_id: "answer" } : {}),
      });
      // 正文早于终态，验收前端不会因正文到达提前解除串行限制。
      this.schedule(() => {
        if (terminal(state.status)) return;
        try {
          this.completions.get(id)?.();
        } catch (error) {
          state.status = "failed";
          state.error = { code: "CONFLICT", message: (error as Error).message };
          this.emit(id, { type: "run_failed", ...state.error });
          return;
        } finally {
          this.completions.delete(id);
        }
        state.status = "completed";
        this.emit(id, { type: "run_completed" });
      }, 400);
    };
    if (streaming) {
      this.emit(id, {
        type: "assistant_message",
        message_id: "result",
        phase: "commentary",
        status: "completed",
        content: "查询已完成，已返回 5,000 条记录。我会结合时间范围整理结论。",
      });
      this.emit(id, {
        type: "assistant_message",
        message_id: "answer",
        phase: "final_answer",
        status: "started",
        content: "",
      });
      const chunks = content.match(/[\s\S]{1,48}/g) ?? [];
      chunks.forEach((chunk, index) =>
        this.schedule(
          () => {
            if (!terminal(state.status))
              this.emit(id, {
                type: "assistant_message",
                message_id: "answer",
                phase: "final_answer",
                status: "delta",
                content: chunk,
              });
          },
          700 + index * 500,
        ),
      );
      this.schedule(finalize, 700 + chunks.length * 500);
    } else finalize();
  }
}
/** 注册真实 HTTP 边界；不连接开发数据库或真实模型。 */
function registerWebAnalysisFixture(app: FastifyInstance, auth: ApiAuthService) {
  const repository = new WebAnalysisRepository();
  const runs: ApiAnalysisServices["runs"] = {
    subscribeEvents: (id, notify) => repository.subscribeEvents(id, notify),
    get: async (context, id) => structuredClone(repository.get(context, id)),
    readEventBatch: async (context, id, after) => {
      const state = repository.get(context, id);
      return structuredClone({
        state,
        events: repository.events
          .get(id)!
          .filter((event) => event.sequence > after)
          .slice(0, 200),
      });
    },
    evidence: async (context, id) => {
      repository.get(context, id);
      return structuredClone(repository.evidence.get(id) ?? []);
    },
    steps: async (context, id) => {
      repository.get(context, id);
      return structuredClone(repository.steps.get(id) ?? []);
    },
    answer: async (context, id, input) => {
      const answer = clarificationAnswerSchema.parse(input);
      const state = repository.get(context, id);
      const key = `${id}:${answer.idempotency_key}`;
      const serialized = JSON.stringify(answer);
      const prior = repository.answers.get(key);
      if (prior) {
        if (prior !== serialized) throw new ApplicationError("CONFLICT", "回答内容不一致");
        return structuredClone(state);
      }
      if (
        state.status !== "waiting_clarification" ||
        state.clarification?.clarification_id !== answer.clarification_id
      )
        throw new ApplicationError("CONFLICT", "问题已经变化");
      const question = state.clarification!;
      if (answer.option_id && !question.options.some((option) => option.id === answer.option_id))
        throw new ApplicationError("INVALID_INPUT", "选项不存在");
      if (answer.custom_input && !question.allow_custom_input)
        throw new ApplicationError("INVALID_INPUT", "当前问题不接受自定义回答");
      repository.answers.set(key, serialized);
      state.status = "created";
      state.clarification = null;
      repository.emit(id, {
        type: "clarification_answered",
        clarification_id: question.clarification_id,
        ...(answer.option_id
          ? { option_id: answer.option_id }
          : { custom_input: answer.custom_input }),
      });
      repository.message(
        id,
        "user",
        answer.custom_input ??
          question.options.find((option) => option.id === answer.option_id)!.label,
      );
      repository.schedule(() => repository.finish(id), 250);
      return structuredClone(state);
    },
    cancel: async (context, id) => {
      const state = repository.get(context, id);
      if (!terminal(state.status)) {
        state.status = "cancelled";
        state.clarification = null;
        repository.emit(id, { type: "run_cancelled" });
      }
      return structuredClone(state);
    },
    execute: async () => {
      throw new ApplicationError("INVALID_INPUT", "此验收入口通过消息执行分析");
    },
  };
  const conversations = new ConversationService(repository, {
    authorizeRun: (context, id) => runs.get(context, id),
    selectAgent: async (_context, id, version) => {
      if (id && (id !== agent.agent_id || version !== agent.version))
        throw new ApplicationError("INVALID_INPUT", "Agent 版本不存在");
      return { agentId: agent.agent_id, agentVersion: agent.version };
    },
  });
  registerConversationRoutes(app, auth, conversations);
  registerAnalysisRoutes(app, auth, runs);
  registerAgentRoutes(app, auth, {
    list: async () => [
      agent,
      { ...agent, agent_id: "disabled", enabled: false, name: "已停用助手" },
    ],
    get: async (_context, id, version) => {
      if (id !== agent.agent_id || (version && version !== agent.version))
        throw new ApplicationError("NOT_FOUND", "Agent 版本不存在");
      return agent;
    },
    publish: async () => {
      throw new ApplicationError("INVALID_INPUT", "验收数据已固定");
    },
    setEnabled: async () => {
      throw new ApplicationError("INVALID_INPUT", "验收数据已固定");
    },
  });
  app.addHook("onClose", async () => repository.close());
  return {
    conversations,
    runs,
    markReportConversation: (id: string) => repository.reportConversations.add(id),
    onComplete: (id: string, operation: () => void) => repository.completions.set(id, operation),
  };
}
export { registerWebAnalysisFixture };
