-- 固定过程定义与版本登记使用同一迁移事务，支持已有 DAS 元数据库升级。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @migration_lock_result INT;
EXEC @migration_lock_result = sp_getapplock
  @Resource = N'das:metadata-schema', @LockMode = N'Exclusive',
  @LockOwner = N'Transaction', @LockTimeout = 60000;
IF @migration_lock_result < 0
  THROW 51000, 'DAS metadata schema migration lock could not be acquired.', 1;

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'002_procedure_definitions')
BEGIN
  IF COL_LENGTH(N'dbo.exposed_source_objects', N'procedure_definition_json') IS NULL
    ALTER TABLE dbo.exposed_source_objects ADD procedure_definition_json NVARCHAR(MAX) NULL;
  INSERT INTO dbo.schema_migrations (migration_id) VALUES (N'002_procedure_definitions');
END;
COMMIT TRANSACTION;
