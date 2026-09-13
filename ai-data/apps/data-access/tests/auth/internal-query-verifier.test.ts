import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JWTPayload } from "jose";

import { InternalQueryVerifier } from "../../src/auth/internal-query-verifier";
import {
  createInternalToken,
  createSignedRequest,
  now,
  nowSeconds,
  publicPem,
} from "../support/internal-query-fixtures";

describe("DAS 短时查询授权验证", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("完整 JWT 与有效的已签名请求通过验证", async () => {
    const verifier = await InternalQueryVerifier.create(publicPem);
    await expect(
      verifier.verify(createSignedRequest(), await createInternalToken()),
    ).resolves.toBeUndefined();
  });

  it.each(["from", "join"])("%s 对象预过滤参与请求签名，修改范围后拒绝", async (target) => {
    const verifier = await InternalQueryVerifier.create(publicPem);
    const request = createSignedRequest(
      {},
      {
        type: "relational_query",
        source_id: "clinical",
        from: {
          object_id: "visit",
          alias: "v",
          filters: {
            logic: "and",
            items: [{ field: "v.dept", op: "eq", data_type: "string", value: "A" }],
          },
        },
        joins: [
          {
            type: "left",
            object_id: "detail",
            alias: "d",
            filters: {
              logic: "and",
              items: [{ field: "d.dept", op: "eq", data_type: "string", value: "A" }],
            },
            on: [{ left: "v.id", op: "eq", right: "d.visit_id" }],
          },
        ],
        select: [{ field: "v.phone", as: "phone" }],
      },
    );
    const token = await createInternalToken();
    await expect(verifier.verify(request, token)).resolves.toBeUndefined();
    if (request.query.type !== "relational_query") throw new Error("测试查询类型错误");
    const relation = target === "from" ? request.query.from : request.query.joins[0];
    relation.filters = { logic: "and", items: [] };
    await expect(verifier.verify(request, token)).rejects.toThrow();
  });

  it.each(["from", "join"])("%s 内层聚合参与签名，修改统计函数后拒绝", async (target) => {
    const verifier = await InternalQueryVerifier.create(publicPem);
    const request = createSignedRequest(
      {},
      {
        type: "relational_query",
        source_id: "clinical",
        from: {
          object_id: "fee",
          alias: "f",
          pre_aggregate: {
            group_by: ["f.visit_id"],
            select: [
              { field: "f.visit_id", as: "visit_id" },
              { field: "f.amount", aggregation: "sum", as: "amount" },
            ],
          },
        },
        joins: [
          {
            type: "left",
            object_id: "prescription",
            alias: "p",
            relation_id: "fee_prescription_by_visit",
            pre_aggregate: {
              group_by: ["p.visit_id"],
              select: [
                { field: "p.visit_id", as: "visit_id" },
                { field: "p.amount", aggregation: "sum", as: "amount" },
              ],
            },
            on: [{ left: "f.visit_id", op: "eq", right: "p.visit_id" }],
          },
        ],
        select: [{ field: "f.amount", aggregation: "sum", as: "amount" }],
      },
    );
    const token = await createInternalToken();
    await expect(verifier.verify(request, token)).resolves.toBeUndefined();
    if (request.query.type !== "relational_query") throw new Error("测试查询类型错误");
    const relation = target === "from" ? request.query.from : request.query.joins[0];
    relation.pre_aggregate!.select[1].aggregation = "max";
    await expect(verifier.verify(request, token)).rejects.toThrow();
  });

  it.each(["2026-09-13 11:59:59", "2026-09-13 12:00:00"])(
    "拒绝截止时间为 %s 的授权",
    async (expires_at) => {
      const verifier = await InternalQueryVerifier.create(publicPem);
      await expect(
        verifier.verify(createSignedRequest({ expires_at }), await createInternalToken()),
      ).rejects.toThrow();
    },
  );

  it("东八区授权截止前一秒仍可验证", async () => {
    const verifier = await InternalQueryVerifier.create(publicPem);
    await expect(
      verifier.verify(
        createSignedRequest({ expires_at: "2026-09-13 12:00:01" }),
        await createInternalToken(),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    "iss",
    "aud",
    "iat",
    "nbf",
    "exp",
    "jti",
    "sub",
    "org_id",
    "analysis_run_id",
    "policy_version",
    "token_use",
  ])("拒绝缺少 %s 的已签名 JWT", async (claim) => {
    const verifier = await InternalQueryVerifier.create(publicPem);
    await expect(
      verifier.verify(createSignedRequest(), await createInternalToken({}, [claim])),
    ).rejects.toThrow();
  });

  it.each<{ scenario: string; claims: JWTPayload }>([
    { scenario: "尚未生效", claims: { nbf: nowSeconds + 1 } },
    { scenario: "已经过期", claims: { exp: nowSeconds - 1 } },
    { scenario: "刚好到期", claims: { exp: nowSeconds } },
    { scenario: "签发时间在未来", claims: { iat: nowSeconds + 1 } },
    { scenario: "签发时间超过短时窗口", claims: { iat: nowSeconds - 61 } },
    { scenario: "签发方错误", claims: { iss: "other-api" } },
    { scenario: "受众错误", claims: { aud: "other-service" } },
    { scenario: "令牌 ID 为空", claims: { jti: "" } },
    { scenario: "令牌 ID 为空白", claims: { jti: " " } },
    { scenario: "用户与请求不同", claims: { sub: "other-user" } },
    { scenario: "组织与请求不同", claims: { org_id: "other-org" } },
    { scenario: "运行与请求不同", claims: { analysis_run_id: "other-run" } },
    { scenario: "策略版本与请求不同", claims: { policy_version: 2 } },
    { scenario: "策略版本类型错误", claims: { policy_version: "1" } },
    { scenario: "令牌用途错误", claims: { token_use: "access" } },
  ])("拒绝$scenario 的 JWT", async ({ claims }) => {
    const verifier = await InternalQueryVerifier.create(publicPem);
    await expect(
      verifier.verify(createSignedRequest(), await createInternalToken(claims)),
    ).rejects.toThrow();
  });

  it("拒绝由其他密钥签发的令牌", async () => {
    const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const verifier = await InternalQueryVerifier.create(
      otherKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    await expect(
      verifier.verify(createSignedRequest(), await createInternalToken()),
    ).rejects.toThrow();
  });

  it.each(["access", "query"] as const)("拒绝签名后被修改的 %s", async (part) => {
    const verifier = await InternalQueryVerifier.create(publicPem);
    const request = createSignedRequest();
    if (part === "access") request.access.output_masks = [];
    else request.query.limit = 1;
    await expect(verifier.verify(request, await createInternalToken())).rejects.toThrow();
  });
});
