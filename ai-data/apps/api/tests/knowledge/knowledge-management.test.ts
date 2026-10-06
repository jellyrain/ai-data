import { describe, expect, it, vi } from "vitest";
import dayjs from "dayjs";
import type { AuthContext } from "../../src/auth/auth-types";
import { ApplicationError } from "../../src/errors/application-error";
import { KnowledgeService } from "../../src/knowledge/knowledge-service";
import { MemoryKnowledgeRepository } from "./memory-knowledge-repository";

const owner: AuthContext = {
  userId: "owner",
  organizationId: "org",
  sessionId: "s",
  roles: [],
  permissions: [],
  dataPolicies: [],
};
const admin = { ...owner, userId: "admin", roles: ["system_admin"] };
const author = { ...owner, userId: "author" };
function setup() {
  const authorizeScope = vi.fn(async () => {});
  const service = new KnowledgeService({
    repository: new MemoryKnowledgeRepository(),
    metrics: { validateDefinition: async () => {} },
    authorizeScope,
    validateSource: async () => {},
    now: () => dayjs("2026-10-03T02:00:00Z").toDate(),
  });
  async function publish(effective_at: string) {
    const candidate = await service.submit(author, {
      idempotency_key: "rule",
      content: { type: "business_rule", title: "门诊口径", body: "按就诊日期统计" },
      scope: {},
    });
    await service.assignOwner(admin, candidate.candidate_id, owner.userId, 1);
    await service.review(owner, candidate.candidate_id, {
      expected_version: 1,
      decision: "approve",
      comment: "通过",
    });
    return service.publish(owner, candidate.candidate_id, { expected_version: 1, effective_at });
  }
  return { service, publish, authorizeScope };
}

describe("知识管理读取", () => {
  it("管理页可读停用和未来版本，普通负责人只读自己的记录", async () => {
    const { service, publish } = setup();
    const record = await publish("2027-01-01 00:00:00");
    expect(await service.listPublished(owner)).toEqual([]);
    expect(await service.listManagement(owner)).toMatchObject([
      { enabled: true, latest: { version: 1 }, current: null },
    ]);
    expect(await service.listManagement(author)).toEqual([]);
    await service.setEnabled(owner, record.knowledge_id, false);
    expect(await service.getManagement(admin, record.knowledge_id)).toMatchObject({
      enabled: false,
      current: null,
    });
    await expect(service.getManagement(author, record.knowledge_id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await service.listManagement({ ...admin, organizationId: "other" })).toEqual([]);
  });
  it("知识管理员读取复核内容权限，管理身份不授予其他负责人发布权", async () => {
    const { service, publish, authorizeScope } = setup();
    const record = await publish("2026-10-03 10:00:00");
    const manager = { ...author, permissions: ["knowledge:manage"] };
    expect(await service.getManagement(manager, record.knowledge_id)).toMatchObject({
      current: { version: 1 },
    });
    await expect(service.setEnabled(manager, record.knowledge_id, false)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    authorizeScope.mockRejectedValue(new ApplicationError("UNAUTHORIZED_OBJECT", "范围已撤回"));
    expect(await service.listManagement(manager)).toEqual([]);
    await expect(service.getManagement(manager, record.knowledge_id)).rejects.toMatchObject({
      code: "UNAUTHORIZED_OBJECT",
    });
  });
  it("仅知识管理员可搜索本组织有效负责人", async () => {
    const { service } = setup();
    expect(await service.ownerOptions(admin, { keyword: "own", limit: 20 })).toEqual([
      { user_id: "owner", username: "owner", display_name: "owner" },
    ]);
    await expect(service.ownerOptions(owner, {})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await service.ownerOptions({ ...admin, organizationId: "other" }, {})).toEqual([]);
  });
});
