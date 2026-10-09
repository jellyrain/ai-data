import type { z } from "zod";
import type {
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  testDatabaseConnectionSchema,
} from "./database-connection";
/** 管理页面可读取的数据库连接及关联关系。 */
type DatabaseConnection = z.infer<typeof databaseConnectionSchema>;
/** 显式创建数据库连接所需的登录信息。 */
type CreateDatabaseConnection = z.infer<typeof createDatabaseConnectionSchema>;
/** 更新连接，保留类型与可选的原密码。 */
type UpdateDatabaseConnection = z.infer<typeof updateDatabaseConnectionSchema>;
/** 已保存连接或当前草稿的数据库发现选项。 */
type TestDatabaseConnection = z.infer<typeof testDatabaseConnectionSchema>;
export type {
  DatabaseConnection,
  CreateDatabaseConnection,
  UpdateDatabaseConnection,
  TestDatabaseConnection,
};
