import {
  catalogRelationSchema,
  relationPublishInputSchema,
  type CatalogRelation,
  type RelationGraph,
  type RelationPublishInput,
} from "@ai-data/contracts";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import type { AuthContext } from "../auth/auth-types";
import { requireCatalogAdmin } from "../catalog-admin/catalog-admin-service";
import { ApplicationError } from "../errors/application-error";
import type { CatalogRelationDependencies } from "./catalog-relation-types";
import { validateRelationConfig, validateUniqueKeys } from "./relation-config";

dayjs.extend(utc);

/** 维护批准方向的关系版本；图浏览不会把入向关系转换成反向执行授权。 */
class CatalogRelationService {
  constructor(private readonly dependencies: CatalogRelationDependencies) {}

  /** 管理图使用完整目录，普通图只保留双方对象和所有连接字段均可见的启用关系。 */
  async graph(
    context: AuthContext,
    sourceId: string,
    objectId: string,
    admin = false,
  ): Promise<RelationGraph> {
    if (admin) requireCatalogAdmin(context);
    const datasets = admin
      ? await this.dependencies.rawCatalog.listRawCatalog(sourceId)
      : (await this.dependencies.catalog.listAuthorized(context, sourceId)).map(
          (item) => item.dataset,
        );
    const columns = new Map(
      datasets.map((item) => [item.object_id, new Set(item.columns.map((column) => column.name))]),
    );
    if (!columns.has(objectId)) throw new ApplicationError("NOT_FOUND", "数据集不存在或无权限访问");
    const relations = (await this.dependencies.repository.list(sourceId)).filter((item) => {
      if (admin) return true;
      const source = columns.get(item.object_id),
        target = columns.get(item.target_object_id);
      return (
        item.enabled &&
        source &&
        target &&
        item.column_pairs.every(
          (pair) => source.has(pair.source_column) && target.has(pair.target_column),
        )
      );
    });
    return {
      source_id: sourceId,
      object_id: objectId,
      outgoing: relations.filter((item) => item.object_id === objectId),
      incoming: relations.filter((item) => item.target_object_id === objectId),
    };
  }

  /** 执行方按数据源、起点对象和稳定关系 ID 读取当前启用方向。 */
  async find(
    context: AuthContext,
    sourceId: string,
    objectId: string,
    relationId: string,
  ): Promise<CatalogRelation | null> {
    return (
      (await this.graph(context, sourceId, objectId)).outgoing.find(
        (item) => item.relation_id === relationId,
      ) ?? null
    );
  }

  /** 每项显式声明创建、更新或停用；一个失败使整批发布回滚。 */
  async publish(
    context: AuthContext,
    sourceId: string,
    input: RelationPublishInput,
  ): Promise<CatalogRelation[]> {
    requireCatalogAdmin(context);
    const parsed = relationPublishInputSchema.parse(input);
    const datasets = await this.dependencies.rawCatalog.listRawCatalog(sourceId);
    return this.dependencies.repository.transaction(sourceId, async (transaction) => {
      const current = await transaction.list();
      const saved: CatalogRelation[] = [];
      for (const change of parsed.changes) {
        const relationId =
          change.action === "disable" ? change.relation_id : change.relation.relation_id;
        const previous = current.find(
          (item) => item.object_id === change.object_id && item.relation_id === relationId,
        );
        if (
          change.action === "create"
            ? previous !== undefined
            : previous?.version !== change.expected_version
        )
          throw new ApplicationError("CONFLICT", "关系版本已更新，请读取当前版本后重试");
        const definition = change.action === "disable" ? previous! : change.relation;
        if (change.action !== "disable") {
          const source = datasets.find((item) => item.object_id === change.object_id),
            target = datasets.find((item) => item.object_id === definition.target_object_id);
          if (!source || !target)
            throw new ApplicationError("INVALID_INPUT", "批准关系引用的数据集不存在");
          if (
            (source.kind !== "table" && source.kind !== "view") ||
            (target.kind !== "table" && target.kind !== "view")
          )
            throw new ApplicationError("INVALID_INPUT", "批准关系两侧必须支持关系查询");
          const sourceConfig = await transaction.findConfig(source.object_id);
          const targetConfig = await transaction.findConfig(target.object_id);
          validateRelationConfig(
            definition,
            source.columns,
            target.columns,
            validateUniqueKeys(sourceConfig, source.columns, "INVALID_INPUT"),
            validateUniqueKeys(targetConfig, target.columns, "INVALID_INPUT"),
            "INVALID_INPUT",
          );
        }
        const record = catalogRelationSchema.parse({
          ...definition,
          source_id: sourceId,
          object_id: change.object_id,
          version: (previous?.version ?? 0) + 1,
          enabled: change.action !== "disable",
          updated_at: dayjs().utcOffset(8).format("YYYY-MM-DD HH:mm:ss"),
        });
        await transaction.save(record);
        saved.push(record);
      }
      return saved;
    });
  }
}

export { CatalogRelationService };
