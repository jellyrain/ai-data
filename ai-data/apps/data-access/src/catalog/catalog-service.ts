import { datasetSchema, type Dataset } from "@ai-data/contracts";

import type { DataSourceConnector } from "../connectors/connector";
import type { DiscoveredDataset } from "../connectors/connector-catalog";
import type { ExposedSourceObject } from "./catalog-types";
import { procedureDefinitionSchema } from "./procedure-definition";

/** 目录路由使用的只读目录能力。 */
interface CatalogReader {
  /** 返回一个数据源对 API 可见的统一数据集目录。 */
  listBySourceId(sourceId: string): Promise<Dataset[]>;
}

/** 读取按数据源初始化的连接器。 */
interface DataSourceConnectorLookup {
  /** 获取当前数据源的运行时连接器。 */
  get(sourceId: string): Promise<DataSourceConnector>;
}

/** 读取管理员维护的可发现对象白名单。 */
interface DiscoverableObjectLookup {
  /** 返回一个数据源允许进入 API 目录的对象映射。 */
  listDiscoverableBySourceId(sourceId: string): Promise<ExposedSourceObject[]>;
}

/** 将连接器目录收敛为 API 可使用的公共 Dataset 目录。 */
class CatalogService implements CatalogReader {
  constructor(
    private readonly connectorLookup: DataSourceConnectorLookup,
    private readonly discoverableObjectLookup: DiscoverableObjectLookup,
  ) {}

  /** 读取并映射指定数据源的可发现目录。 */
  async listBySourceId(sourceId: string): Promise<Dataset[]> {
    const connector = await this.connectorLookup.get(sourceId);
    const discoveredDatasets = await connector.discoverCatalog();

    // HTTP 目录已由虚拟表配置构造，直接采用其配置对象名作为逻辑标识。
    if (connector.kind === "http_api") {
      return discoveredDatasets.map((dataset) =>
        toDataset(sourceId, dataset, dataset.native_object_name),
      );
    }

    // 数据库目录与可发现白名单取交集，以逻辑对象名返回；类型也参与匹配。
    const discoveredByPhysicalObject = new Map(
      discoveredDatasets.flatMap((dataset) => {
        const key = discoveredPhysicalObjectKey(dataset);
        return key === undefined ? [] : [[key, dataset] as const];
      }),
    );
    const exposedObjects = await this.discoverableObjectLookup.listDiscoverableBySourceId(sourceId);
    return exposedObjects.flatMap((object) => {
      const key = exposedPhysicalObjectKey(object);
      const dataset = key === undefined ? undefined : discoveredByPhysicalObject.get(key);
      if (dataset === undefined) return [];
      if (dataset.kind === "stored_procedure") {
        const definition =
          object.procedureDefinition === undefined
            ? undefined
            : procedureDefinitionSchema.parse(object.procedureDefinition);
        return [
          toDataset(
            sourceId,
            {
              ...dataset,
              columns: definition?.columns ?? [],
              query_parameters: definition?.query_parameters ?? [],
              has_complete_output:
                definition !== undefined &&
                connector.kind !== "oracle" &&
                (connector.kind === "postgresql" || !definition.output_parameters?.length) &&
                (connector.kind !== "postgresql" ||
                  definition.query_parameters.length === 0 ||
                  definition.postgresql_parameter_types !== undefined),
            },
            object.objectId,
            object.queryCapabilities,
          ),
        ];
      }
      return [toDataset(sourceId, dataset, object.objectId, object.queryCapabilities)];
    });
  }
}

/** 以类型、Schema 和名称区分物理对象；缺少 Schema 时无法参与白名单匹配。 */
function discoveredPhysicalObjectKey(
  object: Pick<DiscoveredDataset, "kind" | "native_schema_name" | "native_object_name">,
): string | undefined {
  return object.native_schema_name === undefined
    ? undefined
    : `${object.kind}:${object.native_schema_name}:${object.native_object_name}`;
}

/** 生成白名单物理对象映射的键。 */
function exposedPhysicalObjectKey(object: ExposedSourceObject): string | undefined {
  return object.nativeSchemaName === undefined || object.nativeObjectName === undefined
    ? undefined
    : `${object.objectKind}:${object.nativeSchemaName}:${object.nativeObjectName}`;
}

/** 将物理发现结果转换为公共目录；显式白名单能力优先于连接器发现的能力。 */
function toDataset(
  sourceId: string,
  discovered: DiscoveredDataset,
  objectId: string,
  queryCapabilities:
    ExposedSourceObject["queryCapabilities"] | undefined = discovered.query_capabilities,
): Dataset {
  return datasetSchema.parse({
    source_id: sourceId,
    object_id: objectId,
    name: objectId,
    kind: discovered.kind,
    ...(discovered.native_schema_name === undefined
      ? {}
      : { schema_name: discovered.native_schema_name }),
    ...(discovered.source_description === undefined
      ? {}
      : { source_description: discovered.source_description }),
    columns: discovered.columns,
    ...(discovered.has_complete_output === undefined
      ? {}
      : { has_complete_output: discovered.has_complete_output }),
    ...(queryCapabilities === undefined ? {} : { query_capabilities: queryCapabilities }),
    query_parameters: discovered.query_parameters ?? [],
    ...(discovered.freshness === undefined ? {} : { freshness: discovered.freshness }),
  });
}

export { CatalogService };
export type { CatalogReader, DataSourceConnectorLookup, DiscoverableObjectLookup };
