import { describe, expect, it } from "vitest";
import { ApplicationError } from "../../src/errors/application-error";
import {
  habitInput,
  preferenceInput,
  preferenceSetup,
  preferenceSource,
  preferenceUser,
} from "./preference-fixtures";

// 前提：账号可访问偏好引用和来源。操作：保存、观察、确认及管理。预期：原子版本、去重及账号隔离共同生效。
describe("账号偏好与查询习惯", () => {
  it("首次工具保存立即生效，同账号跨会话读取而其他账号与组织隔离", async () => {
    const { service, repository, validateSource } = preferenceSetup();
    const result = await service.save(preferenceUser, preferenceInput, {
      origin: "tool",
      source: preferenceSource,
    });
    expect(result).toMatchObject({
      status: "saved",
      preference: { version: 1, auto_apply: true, source: preferenceSource },
    });
    expect(await service.list({ ...preferenceUser, sessionId: "another" })).toHaveLength(1);
    expect(await service.list({ ...preferenceUser, userId: "other" })).toEqual([]);
    expect(await service.list({ ...preferenceUser, organizationId: "other" })).toEqual([]);
    await expect(
      service.get({ ...preferenceUser, userId: "other" }, preferenceInput.key),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(validateSource).toHaveBeenCalled();
    expect(repository.audits).toHaveLength(1);
  });
  it("保存前验证当前权限和来源，读取时重新验证", async () => {
    const { service, repository, authorize, validateSource } = preferenceSetup();
    authorize.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED", "无权限"));
    await expect(service.save(preferenceUser, preferenceInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    validateSource.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED", "来源无权限"));
    await expect(service.save(preferenceUser, preferenceInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(repository.records.size).toBe(0);
    await service.save(preferenceUser, preferenceInput);
    authorize.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED", "已撤权"));
    await expect(service.get(preferenceUser, preferenceInput.key)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("工具冲突产生固定确认，拒绝保持已有值且只可处理一次", async () => {
    const { service } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput);
    const changed = {
      ...preferenceInput,
      idempotency_key: "change",
      value: { type: "presentation" as const, format: "table" as const },
    };
    const result = await service.save(preferenceUser, changed, {
      origin: "tool",
      source: preferenceSource,
    });
    expect(result.status).toBe("confirmation_required");
    if (result.status !== "confirmation_required") throw new Error("缺少确认");
    expect(
      await service.save(preferenceUser, changed, { origin: "tool", source: preferenceSource }),
    ).toEqual(result);
    expect(
      await service.confirm(preferenceUser, result.confirmation.confirmation_id, false, "reject"),
    ).toBeNull();
    expect(
      await service.confirm(preferenceUser, result.confirmation.confirmation_id, false, "reject"),
    ).toBeNull();
    await expect(
      service.confirm(preferenceUser, result.confirmation.confirmation_id, true, "accept-late"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.get(preferenceUser, preferenceInput.key)).value).toEqual(
      preferenceInput.value,
    );
  });
  it("确认绑定账号与原版本，当前用户的明确修改直接执行并使旧确认失效", async () => {
    const { service } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput);
    const input = {
      ...preferenceInput,
      idempotency_key: "change",
      value: { type: "presentation" as const, format: "table" as const },
    };
    const result = await service.save(preferenceUser, input);
    if (result.status !== "confirmation_required") throw new Error("缺少确认");
    await expect(
      service.confirm(
        { ...preferenceUser, userId: "other" },
        result.confirmation.confirmation_id,
        true,
        "accept",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await service.save(
      preferenceUser,
      { ...input, idempotency_key: "explicit", expected_version: 1 },
      { origin: "user" },
    );
    await expect(
      service.confirm(preferenceUser, result.confirmation.confirmation_id, true, "accept"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("接受确认原子更新，重试只返回同一提交结果", async () => {
    const { service, repository } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput);
    const result = await service.save(preferenceUser, {
      ...preferenceInput,
      idempotency_key: "off",
      auto_apply: false,
    });
    expect(result.status).toBe("saved");
    const restore = await service.save(preferenceUser, {
      ...preferenceInput,
      idempotency_key: "restore",
    });
    if (restore.status !== "confirmation_required") throw new Error("缺少确认");
    expect(restore.confirmation.reason).toBe("auto_apply_disabled");
    const accepted = await service.confirm(
      preferenceUser,
      restore.confirmation.confirmation_id,
      true,
      "accept",
    );
    expect(accepted).toMatchObject({ version: 3, auto_apply: true });
    expect(
      await service.confirm(preferenceUser, restore.confirmation.confirmation_id, true, "accept"),
    ).toEqual(accepted);
    expect(repository.audits.filter((audit) => audit.action === "confirm")).toHaveLength(1);
  });
  it("重复来源只计数一次，新增来源累计频次并保留停用设置", async () => {
    const { service } = preferenceSetup();
    await service.observe(preferenceUser, habitInput, preferenceSource, "observe-1");
    await service.observe(preferenceUser, habitInput, preferenceSource, "observe-2");
    const first = await service.get(preferenceUser, habitInput.key);
    expect(first.use_count).toBe(1);
    await service.setAutoApply(preferenceUser, habitInput.key, {
      auto_apply: false,
      expected_version: first.version,
      idempotency_key: "off",
    });
    await service.observe(
      preferenceUser,
      habitInput,
      { ...preferenceSource, analysis_run_id: "run-2", message_id: "message-2" },
      "observe-3",
    );
    expect(await service.get(preferenceUser, habitInput.key)).toMatchObject({
      auto_apply: false,
      use_count: 2,
    });
  });
  it("后台不同条件不能覆盖既有默认，产生待确认事项", async () => {
    const { service } = preferenceSetup();
    await service.observe(preferenceUser, habitInput, preferenceSource, "observe-1");
    const result = await service.observe(
      preferenceUser,
      { ...habitInput, value: { type: "query_habit", filters: [], dimensions: ["department"] } },
      { ...preferenceSource, analysis_run_id: "run-2" },
      "observe-2",
    );
    expect(result).toMatchObject({
      status: "confirmation_required",
      confirmation: { reason: "conflict" },
    });
    expect((await service.get(preferenceUser, habitInput.key)).value).toEqual(habitInput.value);
  });
  it("幂等键内容变化和并发预期版本不符拒绝覆盖", async () => {
    const { service } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput);
    await expect(
      service.save(preferenceUser, { ...preferenceInput, auto_apply: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const results = await Promise.allSettled(
      ["a", "b"].map((idempotency_key) =>
        service.save(
          preferenceUser,
          { ...preferenceInput, idempotency_key, expected_version: 1, auto_apply: false },
          { origin: "user" },
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
    ]);
  });
  it("删除隐藏内容并保留版本标记，旧确认与延迟后台写入不能复活", async () => {
    const { service, repository } = preferenceSetup();
    await service.observe(preferenceUser, habitInput, preferenceSource, "observe-1");
    const confirmation = await service.save(preferenceUser, {
      ...habitInput,
      idempotency_key: "pending",
      value: { type: "presentation", format: "table" },
    });
    await service.delete(preferenceUser, habitInput.key, {
      expected_version: 1,
      idempotency_key: "delete",
    });
    expect(await service.list(preferenceUser)).toEqual([]);
    expect([...repository.records.values()][0]).not.toHaveProperty("value");
    await expect(
      service.observe(
        preferenceUser,
        habitInput,
        { ...preferenceSource, analysis_run_id: "late" },
        "late",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    if (confirmation.status !== "confirmation_required") throw new Error("缺少确认");
    await expect(
      service.confirm(preferenceUser, confirmation.confirmation.confirmation_id, true, "accept"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await service.save(
        preferenceUser,
        { ...habitInput, idempotency_key: "recreate" },
        { origin: "user" },
      ),
    ).toMatchObject({ status: "saved", preference: { version: 3 } });
    await expect(
      service.confirm(preferenceUser, confirmation.confirmation.confirmation_id, true, "accept"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("模型伪造确认标记被严格合同拒绝", async () => {
    const { service } = preferenceSetup();
    await expect(
      service.save(preferenceUser, { ...preferenceInput, confirmed: true } as never),
    ).rejects.toThrow();
  });
  it("确认提交前复核来源权限，撤权不会改变原偏好", async () => {
    const { service, validateSource } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput);
    const result = await service.save(
      preferenceUser,
      {
        ...preferenceInput,
        idempotency_key: "proposal",
        value: { type: "presentation", format: "table" },
      },
      { source: preferenceSource },
    );
    if (result.status !== "confirmation_required") throw new Error("缺少确认");
    validateSource.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED", "来源已撤权"));
    await expect(
      service.confirm(preferenceUser, result.confirmation.confirmation_id, true, "confirm"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await service.get(preferenceUser, preferenceInput.key)).version).toBe(1);
  });
  it("来源证据顺序变化不重复计数，缺少可验证来源拒绝观察", async () => {
    const { service } = preferenceSetup();
    await service.observe(
      preferenceUser,
      habitInput,
      { ...preferenceSource, evidence_ids: ["a", "b"] },
      "order-1",
    );
    await service.observe(
      preferenceUser,
      habitInput,
      { ...preferenceSource, evidence_ids: ["b", "a"] },
      "order-2",
    );
    expect((await service.get(preferenceUser, habitInput.key)).use_count).toBe(1);
    await expect(
      service.observe(preferenceUser, habitInput, { evidence_ids: [] }, "empty"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("工具保存习惯后后台观察相同来源只累积一次实际使用", async () => {
    const { service } = preferenceSetup();
    await service.save(
      preferenceUser,
      { ...habitInput, idempotency_key: "save-habit" },
      { source: preferenceSource },
    );
    await service.observe(preferenceUser, habitInput, preferenceSource, "observe-habit");
    await service.observe(preferenceUser, habitInput, preferenceSource, "repeat-habit");
    expect(await service.get(preferenceUser, habitInput.key)).toMatchObject({
      use_count: 1,
      version: 2,
    });
  });
  it("确认新查询条件后按新条件累计，重复观察不再次增加次数", async () => {
    const { service } = preferenceSetup();
    await service.observe(preferenceUser, habitInput, preferenceSource, "first-condition");
    await service.observe(
      preferenceUser,
      habitInput,
      { ...preferenceSource, analysis_run_id: "run-two" },
      "second-use",
    );
    const input = {
      ...habitInput,
      value: { type: "query_habit" as const, filters: [], dimensions: ["department"] },
    };
    const source = { ...preferenceSource, analysis_run_id: "different-condition" };
    const result = await service.observe(preferenceUser, input, source, "new-condition");
    if (result.status !== "confirmation_required") throw new Error("缺少确认");
    expect(
      await service.confirm(
        preferenceUser,
        result.confirmation.confirmation_id,
        true,
        "accept-new",
      ),
    ).toMatchObject({ use_count: 1 });
    await service.observe(preferenceUser, input, source, "repeat-new");
    expect((await service.get(preferenceUser, habitInput.key)).use_count).toBe(1);
  });
  it("后续会话读取有效待确认项，并过滤旧版本、已处理及当前不可访问事项", async () => {
    const { service, validateSource } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput);
    const changed = {
      ...preferenceInput,
      idempotency_key: "pending-list",
      value: { type: "presentation" as const, format: "table" as const },
    };
    const result = await service.save(preferenceUser, changed, { source: preferenceSource });
    if (result.status !== "confirmation_required") throw new Error("缺少确认");
    expect(
      await service.listPendingConfirmations({ ...preferenceUser, sessionId: "next-session" }),
    ).toEqual([result.confirmation]);
    expect(await service.listPendingConfirmations({ ...preferenceUser, userId: "other" })).toEqual(
      [],
    );
    validateSource.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED", "来源已撤权"));
    expect(await service.listPendingConfirmations(preferenceUser)).toEqual([]);
    await service.save(
      preferenceUser,
      { ...changed, idempotency_key: "edited", expected_version: 1 },
      { origin: "user" },
    );
    expect(await service.listPendingConfirmations(preferenceUser)).toEqual([]);
  });
  it("清单过滤权限已失效的记忆，内部故障仍抛出", async () => {
    const { service, authorize } = preferenceSetup();
    await service.save(preferenceUser, preferenceInput);
    await service.save(preferenceUser, {
      ...preferenceInput,
      key: "other-key",
      idempotency_key: "other-key",
    });
    authorize.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED", "已撤权"));
    expect((await service.list(preferenceUser)).map((item) => item.key)).toEqual(["other-key"]);
    authorize.mockRejectedValueOnce(new ApplicationError("INTERNAL_ERROR", "存储故障"));
    await expect(service.list(preferenceUser)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
