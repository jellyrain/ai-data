import type { ApiDatasetConfig, CatalogRelation } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { RawCatalogReader } from "./catalog-types";

/** 关系发布事务读取同一数据源的最新关系和唯一键配置。 */
interface CatalogRelationTransaction {
  list(): Promise<CatalogRelation[]>;
  findConfig(objectId: string): Promise<ApiDatasetConfig | null>;
  save(record: CatalogRelation): Promise<void>;
}

/** 数据源范围锁把配置兼容写入与关系发布串行化。 */
interface CatalogRelationRepository {
  list(sourceId: string): Promise<CatalogRelation[]>;
  transaction<T>(
    sourceId: string,
    operation: (transaction: CatalogRelationTransaction) => Promise<T>,
  ): Promise<T>;
}

/** 目录图只使用可见字段；发布验证使用完整 DAS 目录。 */
type CatalogRelationDependencies = {
  repository: CatalogRelationRepository;
  rawCatalog: RawCatalogReader;
  catalog: {
    listAuthorized(
      context: AuthContext,
      sourceId: string,
    ): Promise<{ dataset: Awaited<ReturnType<RawCatalogReader["listRawCatalog"]>>[number] }[]>;
  };
};

export type { CatalogRelationTransaction, CatalogRelationRepository, CatalogRelationDependencies };
