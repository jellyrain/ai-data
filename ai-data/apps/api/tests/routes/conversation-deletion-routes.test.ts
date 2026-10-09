import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { context, createApiDependencies } from "../support/api-fixtures";

describe("会话删除接口", () => {
  it("单个和批量删除使用当前登录身份，拒绝空批次及超量批次", async () => {
    const dependencies = createApiDependencies();
    const app = await createApp(dependencies);
    app.log.level = "silent";
    const headers = { authorization: "Bearer test" };
    try {
      expect(
        (await app.inject({ method: "DELETE", url: "/conversations/one", headers })).statusCode,
      ).toBe(204);
      expect(dependencies.conversations.delete).toHaveBeenLastCalledWith(context, ["one"]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/conversations/delete",
            headers,
            payload: { ids: ["one", "two"] },
          })
        ).statusCode,
      ).toBe(204);
      expect(dependencies.conversations.delete).toHaveBeenLastCalledWith(context, ["one", "two"]);
      for (const ids of [[], Array.from({ length: 101 }, (_, index) => String(index))]) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/conversations/delete",
              headers,
              payload: { ids },
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(dependencies.conversations.delete).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
