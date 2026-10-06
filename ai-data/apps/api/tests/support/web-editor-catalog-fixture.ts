import type { FastifyInstance } from "fastify";
import { catalogRelationSchema, datasetSchema } from "@ai-data/contracts";
import type { ApiAuthService, ApiCatalogService } from "../../src/app-types";
import { registerCatalogRoutes } from "../../src/routes/catalog-routes";
import { registerCatalogSourceRoutes } from "../../src/routes/catalog-source-routes";
import { registerCatalogRelationRoutes } from "../../src/routes/catalog-relation-routes";
import { ApplicationError } from "../../src/errors/application-error";
/** 浏览器使用真实目录路由和合同；数据在隔离测试进程内固定。 */
function registerWebEditorCatalogFixture(app: FastifyInstance, auth: ApiAuthService): void {
  const datasets = [
    ["visits", "门诊记录"],
    ["department", "科室字典"],
    ["fees", "门诊费用"],
  ].map(([id, name]) =>
    datasetSchema.parse({
      source_id: "clinical",
      object_id: id,
      name,
      kind: "table",
      query_parameters: [],
      columns: [
        { name: "department", data_type: "string", nullable: false },
        { name: "count", data_type: "integer", nullable: false },
      ],
    }),
  );
  const authorized = datasets.map((dataset) => ({
    dataset,
    rawColumns: dataset.columns,
    rowPolicies: [],
    allowedRoleIds: ["analyst"],
  }));
  const unavailable = async (): Promise<never> => {
    throw new ApplicationError("INVALID_INPUT", "此目录验收不开放管理写入");
  };
  const catalog: ApiCatalogService = {
    listManaged: unavailable, managedDetail: unavailable,
    listAuthorized: async (_context, source) => (source === "clinical" ? authorized : []),
    searchAuthorized: async (_context, source, text) =>
      source === "clinical" ? authorized.filter((d) => d.dataset.name.includes(text)) : [],
    getAuthorized: async (_context, source, object) =>
      source === "clinical"
        ? (authorized.find((d) => d.dataset.object_id === object) ?? null)
        : null,
    getAuthorizedConfig: unavailable,
    getConfigVersion: async () => 1,
    saveConfig: unavailable,
  };
  registerCatalogRoutes(app, auth, catalog, {
    saveObjectPermission: unavailable,
    saveColumnPermission: unavailable,
    saveRowPolicy: unavailable,
    listObjectPermissions: unavailable,
    listColumnPermissions: unavailable,
    listRowPolicies: unavailable,
  });
  registerCatalogSourceRoutes(app, auth, {
    list: async () => ({ items: [{ source_id: "clinical" }] }),
  });
  registerCatalogRelationRoutes(app, auth, {
    publish: unavailable,
    graph: async (_context, source, object) => ({
      source_id: source,
      object_id: object,
      incoming: [],
      outgoing:
        source === "clinical" && object === "visits"
          ? [
              catalogRelationSchema.parse({
                source_id: source,
                object_id: object,
                target_object_id: "department",
                relation_id: "department",
                description: "就诊科室",
                column_pairs: [{ source_column: "department", target_column: "department" }],
                allowed_join_types: ["left", "inner"],
                version: 1,
                enabled: true,
                updated_at: "2026-09-28 08:00:00",
              }),
            ]
          : [],
    }),
  });
}
export { registerWebEditorCatalogFixture };
