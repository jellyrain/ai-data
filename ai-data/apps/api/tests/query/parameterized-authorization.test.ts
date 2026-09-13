import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  stableStringify,
  type ApiDatasetConfig,
  type ColumnPermission,
  type Dataset,
  type RowPolicy,
} from "@ai-data/contracts";

import type { AuthContext } from "../../src/auth/auth-types";
import { JwtService } from "../../src/auth/jwt-service";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";
import { config } from "../support/api-fixtures";

const identity: AuthContext = {
  userId: "user-a",
  organizationId: "org-a",
  sessionId: "session-a",
  roles: ["clinician"],
  roleIds: ["role-a"],
  permissions: [],
  dataPolicies: [],
};
const query = {
  type: "parameterized_query",
  source_id: "clinical",
  from: { object_id: "report", alias: "r" },
};
const bindings = [{ field: "dept", parameter: "department", operator: "eq" as const }];
const columns: Dataset["columns"] = [
  { name: "dept", data_type: "string", nullable: false },
  { name: "org", data_type: "string", nullable: false },
  { name: "phone", data_type: "string", nullable: true },
];
let jwt: JwtService;
let verificationKey: KeyObject;
beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  verificationKey = publicKey;
  jwt = await JwtService.create({
    ...config,
    jwt: {
      ...config.jwt,
      signing_private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      verification_public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  });
});

/** 构造当前角色的一条允许范围。 */
function row(condition: RowPolicy["condition"], role_id = "role-a"): RowPolicy {
  return { object_id: "report", role_id, effect: "allow", condition };
}

/** 每个场景独立提供可信物理目录、管理员配置和当前身份权限。 */
function setup(
  options: {
    dataset?: Partial<Dataset>;
    config?: Partial<ApiDatasetConfig>;
    rowPolicies?: RowPolicy[];
    columnPermissions?: ColumnPermission[];
    roleIds?: string[];
  } = {},
) {
  const dataset = {
    source_id: "clinical",
    object_id: "report",
    name: "report",
    kind: "stored_procedure" as const,
    has_complete_output: true,
    columns,
    query_parameters: [
      {
        name: "department",
        data_type: "string" as const,
        required: false,
        allowed_ops: ["eq" as const],
      },
      {
        name: "organization",
        data_type: "string" as const,
        required: false,
        allowed_ops: ["eq" as const],
      },
      {
        name: "period",
        data_type: "integer" as const,
        required: true,
        allowed_ops: ["eq" as const],
        default_value: 7,
      },
    ],
    ...options.dataset,
  };
  const businessConfig = {
    source_id: "clinical",
    object_id: "report",
    approved_relations: [],
    column_descriptions: [],
    column_policies: [],
    ...options.config,
  };
  const save = vi.fn(async () => {});
  const catalog = new BusinessCatalogService(
    { listRawCatalog: async () => [dataset] },
    { find: async () => businessConfig, listBySourceId: async () => [businessConfig], save },
    {
      saveObjectPermission: async () => {},
      saveColumnPermission: async () => {},
      saveRowPolicy: async () => {},
      listObjectPermissions: async () =>
        (options.roleIds ?? ["role-a"]).map((role_id) => ({
          role_id,
          object_id: "report",
          effect: "allow" as const,
        })),
      listColumnPermissions: async () => options.columnPermissions ?? [],
      listRowPolicies: async () => options.rowPolicies ?? [],
    },
  );
  return { catalog, save, businessConfig, service: new QueryAuthorizationService(catalog, jwt) };
}

/** 参数输入保持公共 DSL 的单个类型化值。 */
function parameter(value: unknown, name = "department", data_type = "string") {
  return { name, value, data_type };
}

describe("参数化查询的完整输出授权", () => {
  it.each([false, undefined])("输出完整性为 %s 时拒绝签发", async (has_complete_output) => {
    const { service } = setup({ dataset: { has_complete_output } });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it("固定输出中的隐藏列导致整个调用被拒绝", async () => {
    const { service } = setup({
      columnPermissions: [
        { role_id: "role-a", object_id: "report", column: "phone", effect: "deny" },
      ],
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "UNAUTHORIZED_COLUMN",
    });
  });

  it("允许列表未覆盖完整固定输出时拒绝", async () => {
    const { service } = setup({
      columnPermissions: [
        { role_id: "role-a", object_id: "report", column: "dept", effect: "allow" },
      ],
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "UNAUTHORIZED_COLUMN",
    });
  });

  it("没有行限制时补齐普通默认值并签名固定输出脱敏规则", async () => {
    const { service } = setup({
      config: {
        column_policies: [
          {
            field: "phone",
            default_masking: {
              type: "partial_mask",
              prefix_length: 0,
              suffix_length: 0,
              mask_character: "*",
            },
            unmasked_role_ids: [],
          },
        ],
      },
    });
    const { request } = await service.authorize(query, identity);
    expect(request.query).toMatchObject({ parameters: [parameter(7, "period", "integer")] });
    expect(request.access.output_masks).toEqual([
      {
        result_column: "phone",
        rule: { type: "partial_mask", prefix_length: 0, suffix_length: 0, mask_character: "*" },
      },
    ]);
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(stableStringify({ access: request.access, query: request.query })),
        verificationKey,
        Buffer.from(request.signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("明文豁免角色保留固定列", async () => {
    const { service } = setup({
      config: {
        column_policies: [
          {
            field: "phone",
            default_masking: {
              type: "partial_mask",
              prefix_length: 0,
              suffix_length: 0,
              mask_character: "*",
            },
            unmasked_role_ids: ["role-a"],
          },
        ],
      },
    });
    expect((await service.authorize(query, identity)).request.access.output_masks).toEqual([]);
  });

  it("用可信目录覆盖调用方输出声明并将完整定义纳入签名", async () => {
    const { service } = setup({
      dataset: {
        columns: columns.map((column) => ({ ...column, source_description: "物理说明" })),
      },
    });
    const { request } = await service.authorize(
      { ...query, expected_output: [{ name: "fake", data_type: "integer", nullable: true }] },
      identity,
    );
    expect(request.query).toMatchObject({ expected_output: columns });
    const tampered = { ...request.query, expected_output: [columns[0]] };
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(stableStringify({ access: request.access, query: tampered })),
        verificationKey,
        Buffer.from(request.signature, "base64url"),
      ),
    ).toBe(false);
  });

  it.each([{ outputColumns: [] }, { outputColumns: [columns[0], columns[0]] }])(
    "拒绝空或重复固定输出 $outputColumns",
    async ({ outputColumns }) => {
      const { service } = setup({ dataset: { columns: outputColumns } });
      await expect(service.authorize(query, identity)).rejects.toBeDefined();
    },
  );
});

describe("参数化查询的受控范围绑定", () => {
  it("存在行范围且没有管理员绑定时拒绝", async () => {
    const { service } = setup({ rowPolicies: [row({ field: "dept", op: "eq", value: "A" })] });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it("从可信部门上下文的唯一范围生成参数并覆盖权限参数默认值", async () => {
    const { service } = setup({
      config: {
        query_permission_bindings: bindings,
        query_parameter_policies: [{ name: "department", default_value: "ALL" }],
      },
      rowPolicies: [
        row({ field: "dept", op: "in", value_from: "permission_context.department_ids" }),
      ],
    });
    const { request } = await service.authorize(query, {
      ...identity,
      permissionContext: { department_ids: ["A"] },
    });
    expect(request.query).toMatchObject({
      parameters: expect.arrayContaining([parameter("A"), parameter(7, "period", "integer")]),
    });
  });

  it("必填权限参数由 API 从当前范围补齐", async () => {
    const { service } = setup({
      dataset: {
        query_parameters: [
          {
            name: "department",
            data_type: "string",
            required: true,
            allowed_ops: ["eq"],
            default_value: "ALL",
          },
        ],
      },
      config: { query_permission_bindings: bindings },
      rowPolicies: [row({ field: "dept", op: "eq", value: "A" })],
    });
    expect((await service.authorize(query, identity)).request.query).toMatchObject({
      parameters: [parameter("A")],
    });
  });

  it("HTTP 数据集使用相同的权限参数和完整输出授权", async () => {
    const { service } = setup({
      dataset: { kind: "api_dataset" },
      config: { query_permission_bindings: bindings },
      rowPolicies: [row({ field: "dept", op: "eq", value: "A" })],
    });
    expect((await service.authorize(query, identity)).request.query).toMatchObject({
      parameters: expect.arrayContaining([parameter("A")]),
    });
  });

  it("调用方可以选择允许集合中的一个标量", async () => {
    const { service } = setup({
      config: { query_permission_bindings: bindings },
      rowPolicies: [row({ field: "dept", op: "in", value: ["A", "B"] })],
    });
    expect(
      (await service.authorize({ ...query, parameters: [parameter("B")] }, identity)).request.query,
    ).toMatchObject({ parameters: expect.arrayContaining([parameter("B")]) });
  });

  it("缺少参数时不能把多值权限范围缩小为其中一个值", async () => {
    const { service } = setup({
      config: { query_permission_bindings: bindings },
      rowPolicies: [row({ field: "dept", op: "in", value: ["A", "B"] })],
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it("不同字段的 OR 范围不能自动转换为两个参数的 AND", async () => {
    const { service } = setup({
      config: {
        query_permission_bindings: [
          ...bindings,
          { field: "org", parameter: "organization", operator: "eq" },
        ],
      },
      rowPolicies: [
        row({ field: "dept", op: "eq", value: "A" }),
        row({ field: "org", op: "eq", value: "org-a" }),
      ],
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it.each([
    { department: "A", canInferOrganization: false },
    { department: "B", canInferOrganization: true },
  ])(
    "显式科室为 $department 时从剩余权限树判断机构是否唯一",
    async ({ department, canInferOrganization }) => {
      const { service } = setup({
        config: {
          query_permission_bindings: [
            ...bindings,
            { field: "org", parameter: "organization", operator: "eq" },
          ],
        },
        rowPolicies: [
          row({ field: "dept", op: "eq", value: "A" }),
          row({ field: "org", op: "eq", value: "org-a" }),
        ],
      });
      const result = service.authorize({ ...query, parameters: [parameter(department)] }, identity);
      if (canInferOrganization)
        expect((await result).request.query).toMatchObject({
          parameters: expect.arrayContaining([parameter("org-a", "organization")]),
        });
      else await expect(result).rejects.toMatchObject({ code: "POLICY_REJECTED" });
    },
  );

  it("布尔权限按完整布尔域推导唯一参数", async () => {
    const { service } = setup({
      dataset: {
        columns: [{ name: "dept", data_type: "boolean", nullable: false }],
        query_parameters: [
          { name: "department", data_type: "boolean", required: true, allowed_ops: ["eq"] },
        ],
      },
      config: { query_permission_bindings: bindings },
      rowPolicies: [row({ field: "dept", op: "eq", value: false })],
    });
    expect((await service.authorize(query, identity)).request.query).toMatchObject({
      parameters: [parameter(false, "department", "boolean")],
    });
  });

  it("候选状态超出上限时要求显式参数，显式授权值可以执行", async () => {
    const choices = Array.from({ length: 4096 }, (_, index) => `department-${index}`);
    const selected = choices.at(-1)!;
    const { service } = setup({
      config: { query_permission_bindings: bindings },
      rowPolicies: [row({ field: "dept", op: "in", value: choices })],
    });
    const context = {
      ...identity,
      dataPolicies: [
        {
          resource: "report",
          field: "dept",
          operator: "eq" as const,
          value: selected,
          mandatory: true as const,
        },
      ],
    };
    await expect(service.authorize(query, context)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
    expect(
      (await service.authorize({ ...query, parameters: [parameter(selected)] }, context)).request
        .query,
    ).toMatchObject({ parameters: expect.arrayContaining([parameter(selected)]) });
  });

  it.each([{ value: "C" }, { value: null }, { value: ["A", "B"] }])(
    "拒绝越界或不能安全等值绑定的输入 $value",
    async ({ value }) => {
      const { service } = setup({
        config: { query_permission_bindings: bindings },
        rowPolicies: [row({ field: "dept", op: "in", value: ["A", "B"] })],
      });
      await expect(
        service.authorize({ ...query, parameters: [parameter(value)] }, identity),
      ).rejects.toBeDefined();
    },
  );

  it("角色允许并集再与 mandatory 范围相交，选择匹配的允许值", async () => {
    const { service } = setup({
      config: { query_permission_bindings: bindings },
      rowPolicies: [
        row({ field: "dept", op: "eq", value: "A" }),
        row({ field: "dept", op: "eq", value: "B" }),
      ],
    });
    const { request } = await service.authorize(query, {
      ...identity,
      dataPolicies: [
        { resource: "report", field: "dept", operator: "eq", value: "B", mandatory: true },
      ],
    });
    expect(request.query).toMatchObject({ parameters: expect.arrayContaining([parameter("B")]) });
  });

  it("角色与 mandatory 范围冲突时拒绝", async () => {
    const { service } = setup({
      config: { query_permission_bindings: bindings },
      rowPolicies: [row({ field: "dept", op: "eq", value: "A" })],
    });
    await expect(
      service.authorize(query, {
        ...identity,
        dataPolicies: [
          { resource: "report", field: "dept", operator: "eq", value: "B", mandatory: true },
        ],
      }),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });

  it("OR 中每个受限字段仍须存在可靠绑定", async () => {
    const { service } = setup({
      config: { query_permission_bindings: bindings },
      rowPolicies: [
        row({ field: "dept", op: "eq", value: "A" }),
        row({ field: "org", op: "eq", value: "org-a" }),
      ],
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it("多字段 OR 与强制范围按完整参数组合校验", async () => {
    const { service } = setup({
      config: {
        query_permission_bindings: [
          ...bindings,
          { field: "org", parameter: "organization", operator: "eq" },
        ],
      },
      rowPolicies: [
        row({ field: "dept", op: "eq", value: "A" }),
        row({ field: "org", op: "eq", value: "org-a" }),
      ],
    });
    const { request } = await service.authorize(
      { ...query, parameters: [parameter("B"), parameter("org-a", "organization")] },
      {
        ...identity,
        dataPolicies: [
          { resource: "report", field: "dept", operator: "eq", value: "B", mandatory: true },
        ],
      },
    );
    expect(request.query).toMatchObject({
      parameters: expect.arrayContaining([parameter("B"), parameter("org-a", "organization")]),
    });
  });

  it("完整输入组合未命中任何角色分支时拒绝签名", async () => {
    const { service } = setup({
      config: {
        query_permission_bindings: [
          ...bindings,
          { field: "org", parameter: "organization", operator: "eq" },
        ],
      },
      rowPolicies: [
        row({ field: "dept", op: "eq", value: "A" }),
        row({ field: "org", op: "eq", value: "org-a" }),
      ],
    });
    const sign = vi.spyOn(jwt, "signQueryRequest");
    const count = sign.mock.calls.length;
    await expect(
      service.authorize(
        { ...query, parameters: [parameter("B"), parameter("org-b", "organization")] },
        identity,
      ),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
    expect(sign.mock.calls).toHaveLength(count);
  });

  it("系统管理员的 mandatory 范围仍需要权限参数绑定", async () => {
    const { service } = setup();
    await expect(
      service.authorize(query, {
        ...identity,
        roles: ["system_admin"],
        dataPolicies: [
          { resource: "report", field: "dept", operator: "eq", value: "A", mandatory: true },
        ],
      }),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });

  it("另一获准角色提供全范围时仍绑定 mandatory 范围", async () => {
    const { service } = setup({
      roleIds: ["role-a", "role-b"],
      config: {
        query_permission_bindings: [{ field: "org", parameter: "organization", operator: "eq" }],
      },
      rowPolicies: [row({ field: "dept", op: "eq", value: "A" })],
    });
    const { request } = await service.authorize(query, {
      ...identity,
      roleIds: ["role-a", "role-b"],
      dataPolicies: [
        { resource: "report", field: "org", operator: "eq", value: "org-a", mandatory: true },
      ],
    });
    expect(request.query).toMatchObject({
      parameters: expect.arrayContaining([parameter("org-a", "organization")]),
    });
  });

  it.each<RowPolicy["condition"]>([
    { field: "dept", op: "neq", value: "A" },
    { field: "dept", op: "not_in", value: ["A"] },
    { field: "dept", op: "between", value: ["A", "C"] },
    { field: "dept", op: "is_null" },
    { field: "dept", op: "not_null" },
    { field: "dept", op: "eq", value: null },
    { field: "dept", op: "in", value: [] },
    { field: "dept", op: "eq", value_from: "permission_context.missing" },
    { field: "missing", op: "eq", value: "A" },
  ])("拒绝不可表达的 $op 授权范围", async (condition) => {
    const { service } = setup({
      config: { query_permission_bindings: bindings },
      rowPolicies: [row(condition)],
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });
});

describe("参数输入与管理员配置校验", () => {
  it.each([
    [parameter("A"), parameter("B")],
    [parameter("A", "missing")],
    [parameter(7, "department", "integer")],
  ])("拒绝重复、未知或类型不匹配的参数 %j", async (...parameters) => {
    const { service } = setup();
    await expect(service.authorize({ ...query, parameters }, identity)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("API 普通默认值覆盖 DAS 默认值后写入最终参数", async () => {
    const { service } = setup({
      config: { query_parameter_policies: [{ name: "period", default_value: 14 }] },
    });
    expect((await service.authorize(query, identity)).request.query).toMatchObject({
      parameters: [parameter(14, "period", "integer")],
    });
  });

  it("普通参数的显式输入保留并覆盖默认值", async () => {
    const { service } = setup();
    expect(
      (
        await service.authorize(
          { ...query, parameters: [parameter(21, "period", "integer")] },
          identity,
        )
      ).request.query,
    ).toMatchObject({ parameters: [parameter(21, "period", "integer")] });
  });

  it("API 只收紧原本可省略的普通参数", async () => {
    const { service } = setup({
      config: { query_parameter_policies: [{ name: "department", required: true }] },
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      service.authorize({ ...query, parameters: [parameter("A")] }, identity),
    ).resolves.toBeDefined();
  });

  it("DAS 重复声明输入参数时拒绝", async () => {
    const definition = {
      name: "department",
      data_type: "string" as const,
      required: false,
      allowed_ops: ["eq" as const],
    };
    const { service } = setup({ dataset: { query_parameters: [definition, definition] } });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it("管理员可以保存类型匹配的绑定和普通参数收窄策略", async () => {
    const { catalog, save, businessConfig } = setup({
      config: {
        query_permission_bindings: bindings,
        query_parameter_policies: [{ name: "period", default_value: 14 }],
      },
    });
    await catalog.saveConfig(businessConfig);
    expect(save).toHaveBeenCalledWith(businessConfig);
  });

  it("普通必填参数缺少输入与默认值时拒绝", async () => {
    const { service } = setup({
      dataset: {
        query_parameters: [
          { name: "department", data_type: "string", allowed_ops: ["eq"], required: true },
        ],
      },
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it.each([
    {
      query_permission_bindings: [
        { field: "missing", parameter: "department", operator: "eq" as const },
      ],
    },
    {
      query_permission_bindings: [{ field: "dept", parameter: "missing", operator: "eq" as const }],
    },
    {
      query_permission_bindings: [{ field: "dept", parameter: "period", operator: "eq" as const }],
    },
    { query_permission_bindings: [...bindings, ...bindings] },
    { query_parameter_policies: [{ name: "missing", default_value: 1 }] },
    { query_parameter_policies: [{ name: "period", default_value: "invalid" }] },
    { query_parameter_policies: [{ name: "period", required: false }] },
    { query_parameter_policies: [{ name: "period", allowed_ops: ["in" as const] }] },
  ])("保存时拒绝无效绑定或参数策略 %j", async (input) => {
    const { catalog, save, businessConfig } = setup();
    await expect(catalog.saveConfig({ ...businessConfig, ...input })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("读取后变成无效的绑定也拒绝签发", async () => {
    const { service } = setup({
      config: {
        query_permission_bindings: [{ field: "dept", parameter: "missing", operator: "eq" }],
      },
    });
    await expect(service.authorize(query, identity)).rejects.toBeDefined();
  });

  it("同一返回列的冲突脱敏配置不能通过先匹配规则绕过", async () => {
    const { service } = setup({
      config: {
        column_policies: [
          { field: "phone", default_masking: { type: "none" }, unmasked_role_ids: [] },
          {
            field: "phone",
            default_masking: {
              type: "partial_mask",
              prefix_length: 0,
              suffix_length: 0,
              mask_character: "*",
            },
            unmasked_role_ids: [],
          },
        ],
      },
    });
    await expect(service.authorize(query, identity)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });
});
