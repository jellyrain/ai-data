-- API 元数据库迁移使用事务级应用锁，多个实例启动时串行执行本应用的 DDL。
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @migration_lock_result INT;
EXEC @migration_lock_result = sp_getapplock
  @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive',
  @LockOwner = N'Transaction',
  @LockTimeout = 60000;

IF @migration_lock_result < 0
  THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;

IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
BEGIN
  -- 记录已应用的迁移标识；applied_at 使用 SQL Server 本地时间。
  CREATE TABLE dbo.schema_migrations (
    migration_id NVARCHAR(128) NOT NULL PRIMARY KEY,
    applied_at DATETIME2(3) NOT NULL DEFAULT GETDATE()
  );
END;

COMMIT TRANSACTION;
