import type { z } from "zod";
import type {
  dataSourceManagementConfigSchema,
  managedDataSourceSchema,
  managedDataSourceDetailSchema,
  managedSourceObjectSchema,
  managedSourceObjectsSchema,
  managedSecretReferenceSchema,
  manageableSourceObjectSchema,
} from "./data-source-management";
/** 数据库源保存输入及可选修订基准。 */
type DataSourceManagementConfig = z.infer<typeof dataSourceManagementConfigSchema>;
/** 完整公开源配置。 */
type ManagedDataSource = z.infer<typeof managedDataSourceSchema>;
/** 源配置与可比较指纹。 */
type ManagedDataSourceDetail = z.infer<typeof managedDataSourceDetailSchema>;
/** 完整白名单记录。 */
type ManagedSourceObject = z.infer<typeof managedSourceObjectSchema>;
/** 白名单集合和版本基准。 */
type ManagedSourceObjects = z.infer<typeof managedSourceObjectsSchema>;
/** 可选共享凭据引用。 */
type ManagedSecretReference = z.infer<typeof managedSecretReferenceSchema>;
/** 数据库当前可发现对象。 */
type ManageableSourceObject = z.infer<typeof manageableSourceObjectSchema>;
export type {
  DataSourceManagementConfig,
  ManagedDataSource,
  ManagedDataSourceDetail,
  ManagedSourceObject,
  ManagedSourceObjects,
  ManagedSecretReference,
  ManageableSourceObject,
};
