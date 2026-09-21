import { describe, expect, it, vi } from "vitest";
import { queryDslSchema, userPreferenceInputSchema } from "@ai-data/contracts";
import { MemoryAccess } from "../../src/memory/memory-access";
import { context } from "../support/api-fixtures";

function setup() {
  const execute = vi.fn(async () => ({
    rows: [{ user_id: "author", conversation_id: "conversation" }],
    rowsAffected: [],
  }));
  const authorize = vi.fn(async (input) => {
    queryDslSchema.parse(input);
    return {};
  });
  const access = new MemoryAccess({
    database: { execute },
    catalog: () => ({
      getAuthorized: async () => ({
        dataset: { columns: [{ name: "department", data_type: "string" }] },
      }),
    }),
    authorization: () => ({ authorize }),
  } as unknown as ConstructorParameters<typeof MemoryAccess>[0]);
  return { access, execute, authorize };
}
describe("记忆的当前来源与字段权限", () => {
  it("用户提交不能借用他人会话，已获准共享的知识引用不返回消息正文", async () => {
    const { access, execute } = setup();
    const source = { conversation_id: "conversation", evidence_ids: [] };
    await expect(access.source(context, source)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await access.source(context, source, undefined, true);
    expect(
      execute.mock.calls.every(
        (call) => !(call as unknown as [{ sql: string }])[0].sql.includes("content"),
      ),
    ).toBe(true);
  });
  it("记忆字段先查当前目录，再由原查询授权复核条件，隐藏字段不会传给模型", async () => {
    const { access, authorize } = setup();
    const allowed = userPreferenceInputSchema.parse({
      key: "department",
      scope: { source_id: "source", object_id: "orders" },
      value: {
        type: "filters",
        conditions: [{ field: "department", data_type: "string", op: "eq", value: "A" }],
      },
    });
    await access.preference(context, allowed);
    expect(authorize).toHaveBeenCalledTimes(1);
    await expect(
      access.preference(context, { ...allowed, value: { type: "grouping", fields: ["secret"] } }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});
