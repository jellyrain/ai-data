import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PreferenceService } from "../../src/preferences/preference-service";
import { registerPreferenceRoutes } from "../../src/routes/preference-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import {
  preferenceInput,
  preferenceSource,
  preferenceUser,
} from "../preferences/preference-fixtures";

const preference = {
  key: preferenceInput.key,
  scope: preferenceInput.scope,
  value: preferenceInput.value,
  auto_apply: true,
  organization_id: "org",
  user_id: "user",
  version: 1,
  source: preferenceSource,
  updated_at: "2026-09-20 12:00:00",
  use_count: 0,
  last_used_at: null,
};
const headers = { authorization: "Bearer user-token" };
function setup() {
  const service = {
    list: vi.fn<PreferenceService["list"]>(async () => [preference]),
    listPendingConfirmations: vi.fn<PreferenceService["listPendingConfirmations"]>(async () => []),
    get: vi.fn<PreferenceService["get"]>(async () => preference),
    save: vi.fn<PreferenceService["save"]>(async () => ({ status: "saved", preference })),
    delete: vi.fn<PreferenceService["delete"]>(async () => {}),
    setAutoApply: vi.fn<PreferenceService["setAutoApply"]>(async () => preference),
  };
  const auth = { loadContext: vi.fn(async () => preferenceUser) };
  const app = Fastify();
  registerContractErrorHandler(app);
  registerPreferenceRoutes(app, auth, service);
  return { app, auth, service };
}

// 前提：请求通过 Bearer 身份。操作：管理当前账号偏好。预期：账号来自服务端，保存标记为当前用户明确操作。
describe("个人偏好管理 HTTP 接口", () => {
  it("读取清单和详情将当前认证身份传给服务", async () => {
    const { app, service, auth } = setup();
    expect((await app.inject({ url: "/me/preferences", headers })).json()).toEqual({
      items: [preference],
    });
    expect((await app.inject({ url: "/me/preferences/default-time", headers })).json()).toEqual(
      preference,
    );
    expect(auth.loadContext).toHaveBeenCalledWith("user-token");
    expect(service.list).toHaveBeenCalledWith(preferenceUser);
    expect(service.get).toHaveBeenCalledWith(preferenceUser, "default-time");
    await app.close();
  });
  it("按键保存由可信 HTTP 边界明确标记 user 来源", async () => {
    const { app, service } = setup();
    const { key, ...payload } = preferenceInput;
    expect(
      (await app.inject({ method: "PUT", url: `/me/preferences/${key}`, headers, payload }))
        .statusCode,
    ).toBe(200);
    expect(service.save).toHaveBeenCalledWith(preferenceUser, preferenceInput, { origin: "user" });
    await app.close();
  });
  it("删除与自动应用设置完整传递版本及幂等键", async () => {
    const { app, service } = setup();
    const mutation = { expected_version: 1, idempotency_key: "manage" };
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/me/preferences/default-time",
          headers,
          payload: mutation,
        })
      ).statusCode,
    ).toBe(204);
    expect(service.delete).toHaveBeenCalledWith(preferenceUser, "default-time", mutation);
    const payload = { ...mutation, auto_apply: false };
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/me/preferences/default-time/auto-apply",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(service.setAutoApply).toHaveBeenCalledWith(preferenceUser, "default-time", payload);
    await app.close();
  });
  it("未知身份、来源、确认标记和错误版本在路由拒绝", async () => {
    const { app, service } = setup();
    const { key, ...body } = preferenceInput;
    for (const field of [
      { organization_id: "other" },
      { user_id: "other" },
      { confirmed: true },
      { origin: "user" },
      { source: preferenceSource },
      { key: "another" },
    ]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/me/preferences/${key}`,
            headers,
            payload: { ...body, ...field },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/me/preferences/default-time",
          headers,
          payload: { expected_version: 0, idempotency_key: "delete" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: "/me/preferences?user_id=other", headers })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ url: "/me/preferences/default-time?version=1", headers })).statusCode,
    ).toBe(400);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    await app.close();
  });
  it("缺少 Bearer 身份时拒绝进入偏好服务", async () => {
    const { app, service } = setup();
    expect((await app.inject({ url: "/me/preferences" })).statusCode).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
    await app.close();
  });
  it("待确认清单使用静态路由，不被当作普通偏好键读取", async () => {
    const { app, service } = setup();
    expect((await app.inject({ url: "/me/preferences/confirmations", headers })).json()).toEqual({
      items: [],
    });
    expect(service.listPendingConfirmations).toHaveBeenCalledWith(preferenceUser);
    expect(service.get).not.toHaveBeenCalled();
    await app.close();
  });
});
