import { describe, expect, it } from "vitest";
import { ApplicationError } from "../../src/errors/application-error";
import { preferenceInput, preferenceSetup, preferenceUser } from "./preference-fixtures";

describe("用户删除偏好后按当前版本重新设置", () => {
  it("新建、删除与恢复使用递增基准，旧后台写入仍被拒绝", async () => {
    const { service } = preferenceSetup();
    expect(await service.editState(preferenceUser, preferenceInput.key)).toEqual({
      status: "missing",
      version: 0,
    });
    await service.save(
      preferenceUser,
      { ...preferenceInput, expected_version: 0 },
      { origin: "user" },
    );
    expect(await service.editState(preferenceUser, preferenceInput.key)).toMatchObject({
      status: "live",
      version: 1,
      preference: { key: preferenceInput.key },
    });
    await service.delete(preferenceUser, preferenceInput.key, {
      expected_version: 1,
      idempotency_key: "delete",
    });
    expect(await service.editState(preferenceUser, preferenceInput.key)).toEqual({
      status: "deleted",
      version: 2,
    });
    await expect(
      service.save(preferenceUser, {
        ...preferenceInput,
        expected_version: 2,
        idempotency_key: "background",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.save(
        preferenceUser,
        { ...preferenceInput, expected_version: 0, idempotency_key: "stale" },
        { origin: "user" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await service.save(
        preferenceUser,
        { ...preferenceInput, expected_version: 2, idempotency_key: "restore" },
        { origin: "user" },
      ),
    ).toMatchObject({ status: "saved", preference: { version: 3 } });
  });
  it("编辑基准隔离账号与组织，有效内容继续校验当前权限", async () => {
    const { service, authorize } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput, { origin: "user" });
    for (const context of [
      { ...preferenceUser, userId: "other" },
      { ...preferenceUser, organizationId: "other" },
    ])
      expect(await service.editState(context, preferenceInput.key)).toEqual({
        status: "missing",
        version: 0,
      });
    authorize.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED_OBJECT", "对象权限已变化"));
    await expect(service.editState(preferenceUser, preferenceInput.key)).rejects.toMatchObject({
      code: "UNAUTHORIZED_OBJECT",
    });
  });
});
