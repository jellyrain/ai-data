import { z } from "zod";
import {
  knowledgeCandidateSchema,
  knowledgeCandidateInputSchema,
  publishedKnowledgeSchema,
  knowledgeManagementRecordSchema,
  knowledgeOwnerOptionSchema,
  knowledgeReviewRecordSchema,
  knowledgeSourceRecordSchema,
  reportDefinitionVersionSchema,
  updateKnowledgeSchema,
  rollbackKnowledgeSchema,
  knowledgeReviewInputSchema,
  knowledgePublishInputSchema,
  memorySourceSchema,
} from "@ai-data/contracts";
import type {
  KnowledgeCandidateInput,
  UpdateKnowledge,
  RollbackKnowledge,
  MemorySource,
} from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
/** 知识页面使用公开合同校验响应，版本操作由后端服务决定权限。 */
class KnowledgeApi {
  constructor(private readonly request: Transport) {}
  private async list<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    return z
      .object({ items: z.array(schema) })
      .strict()
      .parse(await this.request("/api" + path)).items;
  }
  candidates(management = false) {
    return this.list(
      management ? "/admin/knowledge-candidates" : "/knowledge-candidates",
      knowledgeCandidateSchema,
    );
  }
  getPublished(id: string) {
    return this.read("/knowledge/" + encodeURIComponent(id), publishedKnowledgeSchema);
  }
  published() {
    return this.list("/knowledge", publishedKnowledgeSchema);
  }
  management() {
    return this.list("/admin/knowledge", knowledgeManagementRecordSchema);
  }
  owners(keyword: string) {
    return this.list(
      "/admin/knowledge/owner-options?keyword=" + encodeURIComponent(keyword) + "&limit=50",
      knowledgeOwnerOptionSchema,
    );
  }
  templates() {
    return this.list("/report-templates", reportDefinitionVersionSchema);
  }
  candidate(id: string) {
    return this.read("/knowledge-candidates/" + encodeURIComponent(id), knowledgeCandidateSchema);
  }
  getManagement(id: string) {
    return this.read("/admin/knowledge/" + encodeURIComponent(id), knowledgeManagementRecordSchema);
  }
  versions(id: string) {
    return this.list(
      "/admin/knowledge/" + encodeURIComponent(id) + "/versions",
      publishedKnowledgeSchema,
    );
  }
  reviews(id: string) {
    return this.list(
      "/admin/knowledge-candidates/" + encodeURIComponent(id) + "/reviews",
      knowledgeReviewRecordSchema,
    );
  }
  sources(id: string) {
    return this.list(
      "/knowledge-candidates/" + encodeURIComponent(id) + "/sources",
      knowledgeSourceRecordSchema,
    );
  }
  template(id: string) {
    return this.read(
      "/knowledge-candidates/" + encodeURIComponent(id) + "/template-definition",
      reportDefinitionVersionSchema,
    );
  }
  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(await this.request("/api" + path));
  }
  async submit(input: KnowledgeCandidateInput) {
    return knowledgeCandidateSchema.parse(
      await this.request("/api/knowledge-candidates", {
        method: "POST",
        body: knowledgeCandidateInputSchema.parse(input),
      }),
    );
  }
  async update(id: string, input: UpdateKnowledge) {
    return knowledgeCandidateSchema.parse(
      await this.request("/api/knowledge-candidates/" + encodeURIComponent(id), {
        method: "PUT",
        body: updateKnowledgeSchema.parse(input),
      }),
    );
  }
  async action(id: string, action: "withdraw" | "owner" | "review" | "publish", body: unknown) {
    const input =
      action === "review"
        ? knowledgeReviewInputSchema.parse(body)
        : action === "publish"
          ? knowledgePublishInputSchema.parse(body)
          : body;
    const result = await this.request(
      "/api/" +
        (action === "withdraw" ? "" : "admin/") +
        "knowledge-candidates/" +
        encodeURIComponent(id) +
        "/" +
        action,
      { method: "POST", body: input },
    );
    return action === "publish"
      ? publishedKnowledgeSchema.parse(result)
      : knowledgeCandidateSchema.parse(result);
  }
  async support(id: string, source: MemorySource) {
    return knowledgeCandidateSchema.parse(
      await this.request("/api/knowledge-candidates/" + encodeURIComponent(id) + "/sources", {
        method: "POST",
        body: memorySourceSchema.parse(source),
      }),
    );
  }
  async enabled(id: string, enabled: boolean) {
    z.undefined().parse(
      await this.request("/api/admin/knowledge/" + encodeURIComponent(id) + "/enabled", {
        method: "PUT",
        body: { enabled },
      }),
    );
  }
  async rollback(id: string, input: RollbackKnowledge) {
    return publishedKnowledgeSchema.parse(
      await this.request("/api/admin/knowledge/" + encodeURIComponent(id) + "/rollback", {
        method: "POST",
        body: rollbackKnowledgeSchema.parse(input),
      }),
    );
  }
}
export { KnowledgeApi };
