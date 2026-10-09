import type { Page } from "@playwright/test";
import {
  modelConfigurationSchema,
  modelConfigurationInputSchema,
  agentDefinitionSchema,
  agentVersionSchema,
  createManagedUserSchema,
  managedDepartmentsInputSchema,
  dataSourceManagementConfigSchema,
  deleteDataSourceSchema,
  sourceObjectSelectionRequestSchema,
  apiDatasetConfigSchema,
  relationPublishInputSchema,
  objectPermissionInputSchema,
  columnPermissionInputSchema,
  rowPolicyInputSchema,
  queryPreviewInputSchema,
  sqlServerTransportUpdateSchema,
  type ManagedSourceObject,
  type ApiDatasetConfig,
  type CurrentPolicyState,
  type CatalogRelation,
  type Dataset,
  type DatasetColumn,
} from "@ai-data/contracts";
/** 浏览器交互使用隔离内存合同；实际路由和 SQL 另行验证，所有凭据均为测试值。 */
async function managementFixture(page: Page) {
  const model = modelConfigurationSchema.parse({
    model_id: "rj",
    version: 1,
    name: "院内模型",
    protocol: "responses",
    base_url: "http://model.test/v1",
    model: "rj-v1",
    enabled: true,
    has_api_key: true,
    header_names: [],
  });
  const models = [model];
  const agents = [
    agentVersionSchema.parse({
      agent_id: "clinical",
      version: 1,
      name: "住院分析助手",
      description: "住院与费用分析",
      instructions: "按授权目录查询",
      model_id: "rj",
      model_version: 1,
      tool_names: ["get_tool_schema", "read_skill_reference"],
      skill_names: ["query-dsl"],
      limits: { timeout_ms: 120000, max_tool_calls: 20, max_context_bytes: 65536 },
      skill_fingerprint: "a".repeat(64),
      enabled: true,
    }),
  ];
  const role = {
    id: "analyst-role",
    code: "analyst",
    name: "业务分析员",
    status: "active",
    is_privileged: false,
  };
  const users = [
    {
      id: "u1",
      organization_id: "test-organization",
      username: "doctor",
      display_name: "住院业务员",
      status: "active",
      authorization_version: 1,
    },
  ];
  const departments = new Map([["u1", ["D01"]]]);
  let transportVersion = 1;
  let transport = { encrypt: true, trust_server_certificate: false };
  let transportSaved = false;
  const source = {
    source_id: "clinical",
    connector_kind: "sqlserver",
    secret_ref: "demo-ref",
    target_database: "ai_bi_demo",
    is_enabled: true,
    timeout_ms: 30000,
    connection_pool_limit: 5,
    concurrency_limit: 5,
    row_limit: 10000,
    cost_limit: 1,
  };
  let sourceVersion = 1,
    objectVersion = 1;
  let sourceDeleted = false;
  const sourceMode = {
    deleteConflict: false,
    dropDeleteReceipt: false,
    failTargets: false,
    chineseObjects: false,
    objectCount: 24,
  };
  const revision = (version: number) => String(version).padStart(64, "0");
  let objects: ManagedSourceObject[] = [
    {
      source_id: "clinical",
      object_id: "visits",
      object_kind: "table",
      native_schema_name: "dbo",
      native_object_name: "inpatient",
      is_discoverable: true,
      is_queryable: true,
      query_capabilities: { sortable_fields: [] },
    },
  ];
  const columns: DatasetColumn[] = [
    { name: "id", data_type: "integer", nullable: false },
    { name: "department_id", data_type: "string", nullable: false },
    { name: "amount", data_type: "decimal", nullable: false },
  ];
  const datasets: Dataset[] = ["visits", "departments"].map((id, index) => ({
    source_id: "clinical",
    object_id: id,
    name: index ? "科室字典" : "住院记录",
    kind: "table",
    columns,
    query_parameters: [],
  }));
  let config: ApiDatasetConfig = apiDatasetConfigSchema.parse({
    source_id: "clinical",
    object_id: "visits",
    business_description: "住院明细",
    unique_keys: [["id"]],
    query_capabilities: { sortable_fields: [] },
  });
  let configVersion = 1;
  let relations: CatalogRelation[] = [];
  let policy: CurrentPolicyState = {
    version: 0,
    snapshot: {
      object_permissions: [{ role_id: role.id, object_id: "visits", effect: "allow" }],
      column_permissions: [],
      row_policies: [],
    },
  };
  const writes: { path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.slice(4),
      method = route.request().method(),
      body: unknown = method === "GET" ? undefined : route.request().postDataJSON();
    const send = (value: unknown, status = 200) =>
      route.fulfill({ status, json: value, headers: { "cache-control": "no-store" } });
    const none = () => route.fulfill({ status: 204 });
    const conflict = () =>
      send({ code: "CONFLICT", message: "测试版本冲突", request_id: "management-fixture" }, 409);
    if (method !== "GET") writes.push({ path, body });
    if (path === "/models") {
      if (method === "GET") return send({ items: [models.at(-1)] });
      const input = modelConfigurationInputSchema.parse(body);
      if (input.version !== (models.at(-1)?.version ?? 0) + 1) return conflict();
      const { api_key, headers, ...definition } = input;
      models.push({
        ...definition,
        enabled: true,
        has_api_key: !!api_key,
        header_names: Object.keys(headers ?? {}),
      });
      return send(models.at(-1), 201);
    }
    if (path.startsWith("/models/")) {
      if (path.endsWith("/status")) {
        const enabled = (body as { enabled: boolean }).enabled;
        models.forEach((item) => (item.enabled = enabled));
        return none();
      }
      const result = url.searchParams.has("version")
        ? models.find((item) => item.version === Number(url.searchParams.get("version")))
        : models.at(-1);
      return result ? send(result) : send({ code: "NOT_FOUND", message: "不存在" }, 404);
    }
    if (path === "/agents") {
      if (method === "GET") return send({ items: [agents.at(-1)] });
      const input = agentDefinitionSchema.parse(body);
      if (input.version !== agents.at(-1)!.version + 1) return conflict();
      agents.push({ ...input, skill_fingerprint: "b".repeat(64), enabled: true });
      return send(agents.at(-1), 201);
    }
    if (path.startsWith("/agents/")) {
      if (path.endsWith("/status")) {
        agents.forEach((item) => (item.enabled = (body as { enabled: boolean }).enabled));
        return none();
      }
      return send(
        agents.find((item) => item.version === Number(url.searchParams.get("version"))) ??
          agents.at(-1),
      );
    }
    if (path === "/agent-tools")
      return send({
        items: [
          { name: "get_tool_schema", description: "按需读取参数定义" },
          { name: "read_skill_reference", description: "读取 Skill 子文档" },
        ],
      });
    if (path === "/skills")
      return send({
        items: [{ name: "query-dsl", description: "受控查询说明", fingerprint: "c".repeat(64) }],
      });
    if (path.startsWith("/skills/"))
      return send({
        skill_name: "query-dsl",
        relative_path: url.searchParams.get("path") ?? "SKILL.md",
        content: "# 查询 DSL\n\n使用授权目录中的对象。",
      });
    if (path === "/admin/users/assignment-options")
      return send({ roles: [role], exception_data_scopes: [], department_ids: ["D01", "D02"] });
    if (path === "/admin/catalog/role-options") return send({ items: [role] });
    if (path === "/admin/users") {
      if (method === "GET") return send({ items: users });
      const input = createManagedUserSchema.parse(body);
      const user = {
        id: `u${users.length + 1}`,
        organization_id: "test-organization",
        username: input.username,
        display_name: input.display_name,
        status: "active",
        authorization_version: 1,
      };
      users.push(user);
      return send(user, 201);
    }
    if (path.startsWith("/admin/users/")) {
      const id = path.split("/")[3]!,
        user = users.find((item) => item.id === id)!;
      if (path.endsWith("/authorization"))
        return send({
          user_id: id,
          authorization_version: user.authorization_version,
          roles: [role],
          exception_data_scopes: [],
          department_ids: departments.get(id) ?? [],
        });
      if (path.endsWith("/departments")) {
        const input = managedDepartmentsInputSchema.parse(body);
        if (input.expected_authorization_version !== user.authorization_version) return conflict();
        departments.set(id, input.department_ids);
        user.authorization_version++;
        return none();
      }
      if (path.endsWith("/disable") || path.endsWith("/enable")) {
        user.status = path.endsWith("/enable") ? "active" : "disabled";
        user.authorization_version++;
        return none();
      }
      return send(user);
    }
    if (path === "/admin/data-access/services")
      return send({
        items: ["online", "offline"].map((status, index) => ({
          service_id: index ? "das-old" : "das-demo",
          service_url: "http://das.test:3102",
          service_version: "1",
          status: "healthy",
          connection_status: status,
          last_heartbeat_at: "2026-09-30 12:00:00",
          sources: [
            { source_id: "clinical", status: "healthy", checked_at: "2026-09-30 12:00:00" },
          ],
        })),
      });
    if (path.startsWith("/admin/data-access/services/")) {
      const suffix = path.split("/").slice(5).join("/");
      if (suffix === "database-connections" || suffix === "database-connections/demo-ref") {
        const connection = {
          secret_ref: "demo-ref",
          connector_kind: "sqlserver",
          host: "sql.test",
          port: 1433,
          user: "reader",
          sqlserver_transport: transport,
          source_ids: sourceDeleted ? [] : ["clinical"],
          revision: revision(transportVersion),
        };
        return send(suffix === "database-connections" ? { items: [connection] } : connection);
      }
      if (suffix === "data-source-secrets/demo-ref/sqlserver-transport") {
        if (method === "PUT") {
          const input = sqlServerTransportUpdateSchema.parse(body);
          if (input.expected_revision !== revision(transportVersion)) return conflict();
          transport = input.sqlserver_transport;
          transportVersion++;
          transportSaved = true;
        }
        return send({
          secret_ref: "demo-ref",
          connector_kind: "sqlserver",
          sqlserver_transport: transport,
          origin: transportSaved ? "credential" : "default",
          revision: revision(transportVersion),
          sources: [
            {
              source_id: "clinical",
              sqlserver_transport: transport,
              origin: transportSaved ? "credential" : "default",
            },
          ],
        });
      }
      if (suffix === "database-connections/demo-ref/test") {
        return sourceMode.failTargets
          ? send({ code: "DATA_SOURCE_UNAVAILABLE", message: "数据库暂时不可达" }, 503)
          : send({
              databases: [
                { name: "ai_bi_demo", connect_target: "ai_bi_demo" },
                { name: "archive", connect_target: "archive" },
              ],
            });
      }
      if (suffix === "data-sources/delete") {
        const input = deleteDataSourceSchema.parse(body);
        if (sourceDeleted)
          return sourceMode.dropDeleteReceipt
            ? send({ code: "INTERNAL_ERROR", message: "清理未完成" }, 500)
            : send({ source_id: input.source_id });
        if (
          sourceMode.deleteConflict ||
          input.expected_revision !== revision(sourceVersion) ||
          input.expected_objects_revision !== revision(objectVersion)
        )
          return conflict();
        sourceDeleted = true;
        objects = [];
        sourceVersion++;
        objectVersion++;
        return sourceMode.dropDeleteReceipt
          ? send({ code: "INTERNAL_ERROR", message: "回执丢失" }, 500)
          : send({ source_id: input.source_id });
      }
      if (suffix === "data-sources" && method === "GET")
        return send({ items: sourceDeleted ? [] : [source] });
      if (suffix === "data-sources" && method === "PUT") {
        const input = dataSourceManagementConfigSchema.parse(body);
        if (input.expected_revision !== revision(sourceVersion)) return conflict();
        const { expected_revision: _revision, ...saved } = input;
        void _revision;
        Object.assign(source, saved);
        sourceVersion++;
        objectVersion++;
        return send({ source_id: source.source_id });
      }
      if (suffix.startsWith("data-sources/"))
        return send({ config: sourceDeleted ? null : source, revision: revision(sourceVersion) });
      if (suffix === "data-source-secrets" && method === "GET")
        return send({
          items: [{ secret_ref: "demo-ref", exists: true, source_ids: ["clinical"] }],
        });
      if (suffix === "data-source-objects/discover")
        return send({
          items: [
            {
              object_id: "table.dbo.inpatient",
              kind: "table",
              native_schema_name: "dbo",
              native_object_name: "inpatient",
              columns,
            },
            ...(sourceMode.chineseObjects
              ? [
                  {
                    object_id: "table.dbo.科室",
                    kind: "table",
                    native_schema_name: "dbo",
                    native_object_name: "科室",
                    columns: [
                      { name: "科室编号", data_type: "integer", nullable: false },
                      { name: "科室名称", data_type: "string", nullable: false },
                      { name: "__$operation", data_type: "integer", nullable: false },
                    ],
                  },
                  {
                    object_id: "view.dbo.科室视图",
                    kind: "view",
                    native_schema_name: "dbo",
                    native_object_name: "科室视图",
                    columns: [
                      { name: "科室编号", data_type: "integer", nullable: false },
                      { name: "科室名称", data_type: "string", nullable: false },
                      { name: "__$operation", data_type: "integer", nullable: false },
                    ],
                  },
                ]
              : Array.from({ length: sourceMode.objectCount - 1 }, (_, i) => ({
                  object_id: `table.dbo.department_${i + 1}`,
                  kind: "table",
                  native_schema_name: "dbo",
                  native_object_name: `department_${i + 1}`,
                  columns,
                }))),
          ],
        });
      if (suffix.startsWith("data-source-objects/") && method === "GET")
        return send({ items: objects, revision: revision(objectVersion) });
      if (suffix === "data-source-objects" && method === "PUT") {
        const input = sourceObjectSelectionRequestSchema.parse(body);
        if (input.expected_revision !== revision(objectVersion)) return conflict();
        objects = input.objects.map((item) => ({
          source_id: "clinical",
          object_kind: item.discovered_object_id?.startsWith("view.")
            ? ("view" as const)
            : ("table" as const),
          native_schema_name: "dbo",
          native_object_name: item.discovered_object_id?.split(".").at(-1),
          ...objects.find((row) => row.object_id === item.object_id),
          object_id: item.object_id,
          is_discoverable: item.is_discoverable ?? true,
          is_queryable: item.is_queryable ?? true,
          query_capabilities: item.query_capabilities ?? {},
        }));
        objectVersion++;
        return send({ source_id: "clinical", object_count: objects.length });
      }
      if (suffix === "database-targets")
        return send({ databases: [{ name: "ai_bi_demo", connect_target: "ai_bi_demo" }] });
    }
    if (path === "/admin/catalog/sources")
      return send({ items: [{ source_id: "clinical", status: "healthy" }] });
    if (path === "/admin/catalog/datasets/clinical") return send({ items: datasets });
    if (path.startsWith("/admin/catalog/datasets/clinical/"))
      return send({
        dataset: datasets.find((item) => item.object_id === path.split("/").at(-1)),
        config,
        config_version: configVersion,
      });
    if (path === "/admin/catalog/datasets" && method === "PUT") {
      if ((body as { expected_version: number }).expected_version !== configVersion)
        return conflict();
      const { expected_version: _version, ...value } = body as ApiDatasetConfig & {
        expected_version: number;
      };
      void _version;
      config = apiDatasetConfigSchema.parse(value);
      configVersion++;
      return none();
    }
    if (path === "/admin/catalog/clinical/relations/publish") {
      const input = relationPublishInputSchema.parse(body);
      for (const change of input.changes) {
        if (change.action === "disable")
          relations = relations.map((row) =>
            row.relation_id === change.relation_id
              ? { ...row, enabled: false, version: row.version + 1 }
              : row,
          );
        else {
          const old = relations.find((row) => row.relation_id === change.relation.relation_id);
          relations = relations.filter((row) => row.relation_id !== change.relation.relation_id);
          relations.push({
            ...change.relation,
            source_id: "clinical",
            object_id: change.object_id,
            version: (old?.version ?? 0) + 1,
            enabled: true,
            updated_at: "2026-09-30 12:00:00",
          });
        }
      }
      config = {
        ...config,
        approved_relations: relations
          .filter((row) => row.enabled && row.object_id === "visits")
          .map(
            ({
              source_id: _source,
              object_id: _object,
              version: _version,
              enabled: _enabled,
              updated_at: _time,
              ...row
            }) => {
              void _source;
              void _object;
              void _version;
              void _enabled;
              void _time;
              return row;
            },
          ),
      };
      configVersion++;
      return send({ items: relations });
    }
    if (path.endsWith("/relations")) {
      const object = path.split("/").at(-2)!;
      return send({
        source_id: "clinical",
        object_id: object,
        outgoing: relations.filter((row) => row.object_id === object),
        incoming: relations.filter((row) => row.target_object_id === object),
      });
    }
    if (path === "/admin/catalog/policies/clinical/analyst-role") return send(policy);
    if (path.includes("/policy-versions/")) return send({ items: [] });
    if (
      [
        "/admin/catalog/object-permissions",
        "/admin/catalog/column-permissions",
        "/admin/catalog/row-policies",
      ].includes(path)
    ) {
      const schema = path.endsWith("object-permissions")
        ? objectPermissionInputSchema
        : path.endsWith("column-permissions")
          ? columnPermissionInputSchema
          : rowPolicyInputSchema;
      const value = schema.parse(body);
      if (value.expected_version !== policy.version) return conflict();
      const { source_id: _source, expected_version: _version, ...rule } = value;
      void _source;
      void _version;
      const key = path.endsWith("object-permissions")
        ? "object_permissions"
        : path.endsWith("column-permissions")
          ? "column_permissions"
          : "row_policies";
      policy = { version: policy.version + 2, snapshot: { ...policy.snapshot, [key]: [rule] } };
      return none();
    }
    if (path === "/admin/catalog/query-preview") {
      const input = queryPreviewInputSchema.parse(body);
      return send({ ...input, output_masks: [] });
    }
    return route.fallback();
  });
  return { models, agents, users, writes, sourceMode, datasets };
}
export { managementFixture };
