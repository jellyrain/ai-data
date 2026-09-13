-- 迁移在本文件事务中执行，运行时错误触发事务中止。
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- 多个 DAS 实例共享事务级迁移锁，避免同时初始化同一套元数据表；最多等待 60 秒。
DECLARE @migration_lock_result INT;
EXEC @migration_lock_result = sp_getapplock
  @Resource = N'das:metadata-schema',
  @LockMode = N'Exclusive',
  @LockOwner = N'Transaction',
  @LockTimeout = 60000;

IF @migration_lock_result < 0
  THROW 51000, 'DAS metadata schema migration lock could not be acquired.', 1;

-- 首先建立版本登记表；后续迁移用 migration_id 判断是否已应用。
IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.schema_migrations (
    migration_id NVARCHAR(128) NOT NULL PRIMARY KEY,
    applied_at DATETIME2(3) NOT NULL DEFAULT GETDATE()
  );
END;

COMMIT TRANSACTION;
