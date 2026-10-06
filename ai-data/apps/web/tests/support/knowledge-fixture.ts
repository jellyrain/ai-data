import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  knowledgeCandidateInputSchema,
  saveUserPreferenceInputSchema,
  stableStringify,
  type KnowledgeCandidate,
  type PublishedKnowledge,
  type UserPreference,
  type KnowledgeReviewRecord,
  type MemoryEventSummary,
} from "@ai-data/contracts";
import { definition as reportDefinition } from "../features/reports/fixtures";

/** 浏览器交互使用独立内存合同，领域权限和持久化另由真实 API/SQL 验收。 */
async function knowledgeFixture(page: Page) {
  const now = "2026-10-03 10:00:00",
    org = "test-organization",
    user = "test-admin";
  const preferences = new Map<string, UserPreference>(),
    tombstones = new Map<string, number>();
  const candidates: KnowledgeCandidate[] = [],
    publications: PublishedKnowledge[] = [],
    enabled = new Map<string, boolean>(),
    reviews: KnowledgeReviewRecord[] = [];
  const tasks: MemoryEventSummary[] = [
    {
      event_id: "memory-failed",
      analysis_run_id: "private-run",
      status: "failed",
      attempts: 3,
      created_at: now,
      updated_at: now,
      last_error_code: "MODEL_TIMEOUT",
    },
  ];
  const template = {
    ...structuredClone(reportDefinition),
    report_id: "report-01",
    version: 2,
    organization_id: org,
    user_id: user,
    definition: { ...structuredClone(reportDefinition.definition), title: "组织门诊模板" },
  };
  let next = 0;
  const management = () =>
    [...new Set(publications.map((item) => item.knowledge_id))].map((id) => {
      const items = publications
        .filter((item) => item.knowledge_id === id)
        .sort((a, b) => b.version - a.version);
      return {
        knowledge_id: id,
        enabled: enabled.get(id) !== false,
        latest: items[0]!,
        current:
          enabled.get(id) === false
            ? null
            : (items.find((item) => item.effective_at <= now) ?? null),
      };
    });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      path = decodeURIComponent(url.pathname.slice(4)),
      method = route.request().method();
    const body = route.request().postDataJSON();
    const send = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
        headers: { "cache-control": "no-store" },
      });
    const none = () => route.fulfill({ status: 204 });
    const conflict = () =>
      send({ code: "CONFLICT", message: "版本已变化", request_id: "knowledge-conflict" }, 409);
    if (path === "/metrics") return send({ items: [] });
    if (path === "/me/preferences") return send({ items: [...preferences.values()] });
    if (path === "/me/preferences/confirmations") return send({ items: [] });
    if (path.startsWith("/me/preferences/")) {
      const key = path.split("/")[3]!;
      const current = preferences.get(key),
        version = current?.version ?? tombstones.get(key) ?? 0;
      if (path.endsWith("/edit-state"))
        return send(
          current
            ? { status: "live", version, preference: current }
            : { status: version ? "deleted" : "missing", version },
        );
      if (body.expected_version !== version) return conflict();
      if (method === "DELETE") {
        preferences.delete(key);
        tombstones.set(key, version + 1);
        return none();
      }
      const input = saveUserPreferenceInputSchema.parse({ key, ...body });
      const saved: UserPreference = {
        key,
        scope: input.scope,
        value: input.value,
        auto_apply: input.auto_apply,
        organization_id: org,
        user_id: user,
        version: version + 1,
        updated_at: now,
        source: { evidence_ids: [] },
        use_count: 0,
        last_used_at: null,
      };
      preferences.set(key, saved);
      return send({ status: "saved", preference: saved });
    }
    if (path === "/admin/memory-events") return send({ items: tasks });
    if (path.endsWith("/retry") && path.startsWith("/admin/memory-events/")) {
      if (tasks[0]!.status !== "failed") return conflict();
      tasks[0]!.status = "pending";
      tasks[0]!.attempts = 0;
      return none();
    }
    if (path === "/admin/knowledge/owner-options")
      return send({
        items: [
          { user_id: user, username: "admin", display_name: "测试管理员" },
          { user_id: "test-analyst", username: "analyst", display_name: "指定负责人" },
        ],
      });
    if (path === "/knowledge-candidates" && method === "POST") {
      const input = knowledgeCandidateInputSchema.parse(body);
      const saved: KnowledgeCandidate = {
        candidate_id: "candidate-" + ++next,
        knowledge_id: input.knowledge_id ?? "knowledge-" + next,
        content: input.content,
        scope: input.scope,
        content_hash: createHash("sha256").update(stableStringify(input.content)).digest("hex"),
        organization_id: org,
        version: 1,
        status: "pending",
        created_by: user,
        owner_id: null,
        created_at: now,
        updated_at: now,
      };
      candidates.unshift(saved);
      return send(saved, 201);
    }
    if (["/knowledge-candidates", "/admin/knowledge-candidates"].includes(path))
      return send({ items: candidates });
    if (/^\/(admin\/)?knowledge-candidates\//.test(path)) {
      const parts = path.replace("/admin", "").split("/"),
        item = candidates.find((item) => item.candidate_id === parts[2]);
      if (!item) return send({ code: "NOT_FOUND", message: "候选不存在" }, 404);
      const action = parts[3];
      if (action === "sources")
        return method === "GET"
          ? send({ items: [{ user_id: user, source: { evidence_ids: [] } }] })
          : send(item);
      if (action === "reviews")
        return send({
          items: reviews.filter((value) => value.candidate.candidate_id === item.candidate_id),
        });
      if (action === "template-definition") return send(template);
      if (method === "GET") return send(item);
      if (body.expected_version !== item.version) return conflict();
      if (!action)
        Object.assign(item, {
          content: body.content,
          scope: body.scope,
          version: item.version + 1,
          status: "pending",
        });
      if (action === "owner") Object.assign(item, { owner_id: body.owner_id, status: "pending" });
      if (action === "withdraw") item.status = "withdrawn";
      if (action === "review") {
        reviews.unshift({
          review_id: "review-" + reviews.length,
          candidate: structuredClone(item),
          reviewed_by: user,
          decision: body.decision,
          comment: body.comment,
          reviewed_at: now,
        });
        item.status = body.decision === "approve" ? "approved" : "rejected";
      }
      if (action === "publish") {
        item.status = "published";
        const published: PublishedKnowledge = {
          knowledge_id: item.knowledge_id,
          version:
            publications.filter((value) => value.knowledge_id === item.knowledge_id).length + 1,
          content: item.content,
          scope: item.scope,
          owner_id: item.owner_id!,
          organization_id: org,
          published_by: user,
          source_candidate_id: item.candidate_id,
          effective_at: body.effective_at,
          published_at: now,
        };
        publications.push(published);
        return send(published, 201);
      }
      return send(item);
    }
    if (path === "/knowledge")
      return send({ items: management().flatMap((item) => (item.current ? [item.current] : [])) });
    if (path === "/admin/knowledge") return send({ items: management() });
    if (/^\/(admin\/)?knowledge\//.test(path)) {
      const parts = path.replace("/admin", "").split("/"),
        item = management().find((item) => item.knowledge_id === parts[2]);
      if (!item) return send({ code: "NOT_FOUND", message: "知识不存在" }, 404);
      if (parts[3] === "versions")
        return send({
          items: publications.filter((value) => value.knowledge_id === item.knowledge_id),
        });
      if (parts[3] === "enabled") {
        enabled.set(item.knowledge_id, body.enabled);
        return none();
      }
      return send(path.startsWith("/admin") ? item : item.current);
    }
    if (path === "/reports/report-01/definition") return send(template);
    if (path === "/report-templates")
      return send({
        items: management().some((item) => item.current?.content.type === "report_template")
          ? [template]
          : [],
      });
    return route.fallback();
  });
  return { preferences, candidates, publications, tasks, template };
}
export { knowledgeFixture };
