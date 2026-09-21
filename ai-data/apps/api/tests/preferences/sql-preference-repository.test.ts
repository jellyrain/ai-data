import { describe, expect, it, vi } from "vitest";
import type { MetadataStatement, MetadataTransactionalExecutor } from "@ai-data/metadata";
import { PreferenceService } from "../../src/preferences/preference-service";
import { SqlPreferenceRepository } from "../../src/preferences/sql-preference-repository";
import { preferenceInput, preferenceSource, preferenceUser } from "./preference-fixtures";

const preference = {
  key: preferenceInput.key,
  scope: preferenceInput.scope,
  value: preferenceInput.value,
  auto_apply: true,
  organization_id: preferenceUser.organizationId,
  user_id: preferenceUser.userId,
  version: 1,
  source: preferenceSource,
  updated_at: "2026-09-20 12:00:00",
  use_count: 0,
  last_used_at: null,
};

// 前提：持久化记录及外部事务处于独立信任边界。操作：读取和写入。预期：损坏拒绝，副作用与授权共用外部执行器。
describe("个人偏好 SQL 持久化边界", () => {
  it("外部事务直接执行全部 SQL，并传给权限和来源回调", async () => {
    const statements: MetadataStatement[] = [];
    const external = {
      execute: vi.fn(async (statement: MetadataStatement) => {
        statements.push(statement);
        return {
          rows: statement.sql.startsWith("SELECT id FROM dbo.users")
            ? [{ id: preferenceUser.userId }]
            : [],
          rowsAffected: [],
        };
      }),
    };
    const database = {
      execute: vi.fn(async () => ({ rows: [], rowsAffected: [] })),
      transaction: vi.fn(),
    } as unknown as MetadataTransactionalExecutor;
    const authorize = vi.fn(async () => {});
    const validateSource = vi.fn(async () => {});
    const service = new PreferenceService({
      repository: new SqlPreferenceRepository(database),
      authorize,
      validateSource,
    });
    const result = await service.save(preferenceUser, preferenceInput, {
      executor: external as never,
      source: preferenceSource,
    });
    expect(result.status).toBe("saved");
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.execute).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(
      preferenceUser,
      {
        key: preferenceInput.key,
        scope: preferenceInput.scope,
        value: preferenceInput.value,
        auto_apply: preferenceInput.auto_apply,
      },
      external,
    );
    expect(validateSource).toHaveBeenCalledWith(preferenceUser, preferenceSource, external);
    expect(
      statements.some((statement) =>
        statement.sql.includes("INSERT INTO dbo.preference_operations"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.sql.includes("INSERT INTO dbo.preference_audits")),
    ).toBe(true);
    expect(
      statements.every(
        (statement) =>
          statement.parameters.some(
            (parameter) =>
              parameter.name === "org" && parameter.value === preferenceUser.organizationId,
          ) &&
          statement.parameters.some(
            (parameter) => parameter.name === "user" && parameter.value === preferenceUser.userId,
          ),
      ),
    ).toBe(true);
  });
  it.each([
    { version: 2 },
    { preference_key: "other" },
    { user_id: "other" },
    { preference_json: "invalid-json" },
    { preference_json: JSON.stringify({ ...preference, organization_id: "other" }) },
  ])("索引列与 JSON 不一致或损坏时返回内部错误：%o", async (patch) => {
    const row = {
      organization_id: preferenceUser.organizationId,
      user_id: preferenceUser.userId,
      preference_key: preference.key,
      version: preference.version,
      preference_json: JSON.stringify(preference),
      ...patch,
    };
    const database = {
      execute: async () => ({ rows: [row], rowsAffected: [] }),
    } as unknown as MetadataTransactionalExecutor;
    await expect(
      new SqlPreferenceRepository(database).find(preferenceUser, preference.key),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  it("账号停用或不属于当前组织时拒绝写入事务", async () => {
    const executor = { execute: async () => ({ rows: [], rowsAffected: [] }) };
    const repository = new SqlPreferenceRepository({
      ...executor,
      transaction: async (action) => action(executor),
    });
    const action = vi.fn(async () => {});
    await expect(repository.transaction(preferenceUser, action)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(action).not.toHaveBeenCalled();
  });
});
